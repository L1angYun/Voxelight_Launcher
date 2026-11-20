use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

#[test]
fn c7_loaded_proxy_host_drops_userinfo_but_stays_custom() {
    let mut config = crate::models::Config {
        proxy_mode: "custom".into(),
        proxy_host: "fixture-user:fixture-pass@proxy.example.invalid".into(),
        proxy_port: 8080,
        ..Default::default()
    };
    assert!(strip_host_userinfo(&mut config));
    assert_eq!(config.proxy_host, "proxy.example.invalid");
    assert_eq!(config.proxy_mode, "custom");
    assert!(!serde_json::to_string(&config).unwrap().contains("fixture-pass"));
    assert!(!strip_host_userinfo(&mut config), "a clean host is left alone");
}

#[test]
fn c7_abandoned_credentials_survive_only_a_mode_change() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/proxy-credential-tests")
            .join(uuid::Uuid::new_v4().to_string()),
    ).unwrap();
    let a = crate::models::Config {
        proxy_mode: "custom".into(), proxy_host: "a.example.invalid".into(), proxy_port: 8080, ..Default::default()
    };
    let key = draft_endpoint(&a).unwrap().credential_key();
    crate::secrets::save_service_secret(dir.path(), &key, "{\"username\":\"u\",\"password\":\"p\"}").unwrap();
    let mode_only = crate::models::Config { proxy_mode: "none".into(), ..a.clone() };
    forget_abandoned_credentials(dir.path(), &a, &mode_only).unwrap();
    assert!(crate::secrets::load_service_secret(dir.path(), &key).unwrap().is_some());
    let cleared = crate::models::Config { proxy_host: String::new(), ..a.clone() };
    forget_abandoned_credentials(dir.path(), &a, &cleared).unwrap();
    assert!(crate::secrets::load_service_secret(dir.path(), &key).unwrap().is_none());
}

#[test]
fn c7_proxy_authorization_is_a_sensitive_header() {
    let credentials = Credentials::new("fixture-user".into(), "fixture-pass".into()).unwrap();
    let header = credentials.proxy_authorization().unwrap();
    assert!(header.is_sensitive());
    let encoded = header.to_str().unwrap().split_once(' ').unwrap().1;
    assert!(!format!("{header:?}").contains(encoded));
}

#[test]
fn c7_tls_is_desktop_only_without_silent_java_downgrade() {
    let tls = Settings::parse("custom", "https", "Proxy.Example", 8443).unwrap();
    assert_eq!(tls.endpoint().unwrap().url(), "https://proxy.example:8443");
    assert_eq!(
        tls.validate_game_save("launcher"),
        Err(Error::TlsInheritance)
    );
    assert!(tls.validate_game_save("off").is_ok());
    assert!(tls.validate_game_save("system").is_ok());
    assert_eq!(tls.game_args("launcher", &[]), Err(Error::TlsInheritance));
    assert_eq!(
        tls.game_args("launcher", &["-Dhttp.proxyHost=manual".into()]),
        Err(Error::TlsInheritance)
    );
    assert_eq!(tls.installer_args(), Err(Error::TlsInheritance));
    assert!(tls.game_args("off", &[]).unwrap().is_empty());
}

#[test]
fn c7_jvm_defaults_remain_unchanged_and_manual_http_properties_win() {
    let system = Settings::parse("system", "http", "", 0).unwrap();
    assert!(system.game_args("off", &[]).unwrap().is_empty());
    assert_eq!(
        system.installer_args().unwrap(),
        ["-Djava.net.useSystemProxies=true"]
    );
    let disabled = Settings::parse("none", "http", "", 0).unwrap();
    assert!(disabled.installer_args().unwrap().is_empty());
    let http = Settings::parse("custom", "http", "[::1]", 8080).unwrap();
    assert_eq!(
        http.installer_args().unwrap(),
        [
            "-Dhttp.proxyHost=::1",
            "-Dhttp.proxyPort=8080",
            "-Dhttps.proxyHost=::1",
            "-Dhttps.proxyPort=8080",
            "-Dhttp.nonProxyHosts=localhost|127.*|[::1]",
        ]
    );
    assert!(http
        .game_args("launcher", &["-Dhttps.proxyHost=manual".into()])
        .unwrap()
        .is_empty());
}

#[test]
fn c7_endpoint_and_basic_credentials_are_validated_without_echo() {
    for host in [
        "https://proxy.example",
        "user@proxy.example",
        "abc/def",
        "space here",
        "abc:-1",
        "-bad.example",
        "999.1.1.1",
        "127.1",
        "[]",
    ] {
        assert_eq!(
            Settings::parse("custom", "http", host, 8080).err(),
            Some(Error::InvalidHost),
            "{host}"
        );
    }
    assert_eq!(
        Settings::parse("custom", "socks5", "localhost", 8080).err(),
        Some(Error::InvalidScheme)
    );
    assert_eq!(
        Settings::parse("custom", "http", "localhost", 0).err(),
        Some(Error::InvalidPort)
    );
    assert_eq!(
        Credentials::new("fixture:user".into(), "pass".into()).err(),
        Some(Error::InvalidCredentials)
    );
    assert_eq!(
        Credentials::new("fixture-user".into(), "bad\rvalue".into()).err(),
        Some(Error::InvalidCredentials)
    );
    assert_eq!(
        Credentials::new(String::new(), "pass".into()).err(),
        Some(Error::InvalidCredentials)
    );
    assert_eq!(
        Settings::parse("custom", " HTTPS ", "PROXY.EXAMPLE", 8443).err(),
        Some(Error::InvalidScheme)
    );
}

#[test]
fn c7_credentials_do_not_follow_endpoint_changes() {
    let a = Settings::parse("custom", "https", "PROXY.EXAMPLE", 8443).unwrap();
    let same = Settings::parse("custom", "https", "proxy.example", 8443).unwrap();
    let other_scheme = Settings::parse("custom", "http", "proxy.example", 8443).unwrap();
    let other_port = Settings::parse("custom", "https", "proxy.example", 443).unwrap();
    let other_host = Settings::parse("custom", "https", "proxy-other.example", 8443).unwrap();
    let key = |settings: &Settings| settings.endpoint().unwrap().credential_key();
    assert_eq!(key(&a), key(&same));
    assert_ne!(key(&a), key(&other_host));
    assert_ne!(key(&a), key(&other_port));
    assert_ne!(key(&a), key(&other_scheme));
}

fn accept_or_timeout(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // Windows hands back the listener's non-blocking mode; under load a
                // read could then fail with WouldBlock before the request arrives.
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("proxy fixture got no connection: {error}"),
        }
    }
}

#[test]
fn c7_real_connect_hits_loopback_proxy_and_sends_auth_only_when_configured() {
    for auth in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let settings = Settings::parse("custom", "http", "127.0.0.1", port).unwrap();
        let credentials =
            auth.then(|| Credentials::new("fixture-user".into(), "fixture-pass".into()).unwrap());
        let server = thread::spawn(move || {
            let mut socket = accept_or_timeout(&listener);
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut received = Vec::new();
            let mut byte = [0];
            while received.len() < 8192 && !received.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                received.push(byte[0]);
            }
            let code = if auth {
                "502 Bad Gateway"
            } else {
                "407 Proxy Authentication Required"
            };
            write!(socket, "HTTP/1.1 {code}\r\nContent-Length: 0\r\n\r\n").unwrap();
            String::from_utf8(received).unwrap()
        });
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _context = rt.enter();
        let client = settings
            .apply(
                reqwest::Client::builder().timeout(Duration::from_secs(3)),
                credentials.as_ref(),
            )
            .unwrap()
            .build()
            .unwrap();
        let error = rt
            .block_on(client.head("https://proxy-fixture.invalid/probe").send())
            .unwrap_err();
        assert_eq!(
            classify(&error),
            if auth {
                Error::Connection
            } else {
                Error::Authentication
            }
        );
        // Provider requests surface this code instead of a generic network error.
        assert_eq!(proxy_auth_code(&error).as_deref(), (!auth).then_some("proxy.authentication"));
        let request = server.join().unwrap();
        assert!(request.starts_with("CONNECT proxy-fixture.invalid:443 HTTP/1.1\r\n"));
        let mut actual = request.lines().filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("proxy-authorization").then(|| value.trim())
        });
        if auth {
            use base64::Engine as _;
            let expected = format!("Basic {}", base64::engine::general_purpose::STANDARD
                .encode("fixture-user:fixture-pass"));
            assert!(actual.next() == Some(expected.as_str()), "proxy auth did not match configured fixture");
        }
        assert!(actual.next().is_none(), "unexpected additional proxy auth header");
    }
}

#[test]
fn c7_none_connects_directly_to_loopback_without_forwarding_credentials() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/probe",
        listener.local_addr().unwrap().port()
    );
    let server = thread::spawn(move || {
        let mut socket = accept_or_timeout(&listener);
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = Vec::new();
        let mut byte = [0];
        while received.len() < 8192 && !received.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            received.push(byte[0]);
        }
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
        String::from_utf8(received).unwrap()
    });
    let settings = Settings::parse("none", "http", "", 0).unwrap();
    let credentials = Credentials::new("fixture-user".into(), "fixture-pass".into()).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _context = rt.enter();
    let client = settings
        .apply(
            reqwest::Client::builder().timeout(Duration::from_secs(3)),
            Some(&credentials),
        )
        .unwrap()
        .build()
        .unwrap();
    assert_eq!(rt.block_on(client.head(url).send()).unwrap().status(), 204);
    let request = server.join().unwrap();
    assert!(request.starts_with("HEAD /probe HTTP/1.1\r\n"));
    assert!(!request.to_ascii_lowercase().contains("proxy-authorization"));
}

#[cfg(windows)]
#[test]
fn c7_proxy_credentials_are_dpapi_protected_and_bound_to_the_saved_endpoint() {
    use crate::instances::StagingDirectory;
    let directory = StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/c7-tests")
            .join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let same = Settings::parse("custom", "https", "Proxy.Example", 8443).unwrap();
    let changed = Settings::parse("custom", "https", "Proxy.Example", 443).unwrap();
    let user = "c7-unique-fixture-username";
    let password = "c7-unique-fixture-password";
    assert_eq!(
        store_endpoint_credentials(
            directory.path(),
            &same,
            &changed,
            user.into(),
            password.into()
        ),
        Err(Error::SaveEndpointFirst)
    );
    assert!(!directory.path().join("secrets").exists());
    assert!(store_endpoint_credentials(
        directory.path(),
        &same,
        &same,
        user.into(),
        password.into()
    )
    .unwrap());
    let encrypted: Vec<_> = std::fs::read_dir(directory.path().join("secrets"))
        .unwrap()
        .collect();
    assert_eq!(encrypted.len(), 1);
    let file = encrypted.into_iter().next().unwrap().unwrap().path();
    assert_eq!(file.extension().unwrap(), "dpapi");
    let ciphertext = std::fs::read(&file).unwrap();
    assert!(!ciphertext
        .windows(user.len())
        .any(|bytes| bytes == user.as_bytes()));
    assert!(!ciphertext
        .windows(password.len())
        .any(|bytes| bytes == password.as_bytes()));
    let recovered = get_credentials(directory.path(), same.endpoint().unwrap())
        .unwrap()
        .unwrap();
    assert!(recovered.username == user && recovered.password == password);
    assert!(
        get_credentials(directory.path(), changed.endpoint().unwrap())
            .unwrap()
            .is_none()
    );
    std::fs::write(&file, b"fixture-corrupt-encrypted-record").unwrap();
    assert!(matches!(
        get_credentials(directory.path(), same.endpoint().unwrap()),
        Err(Error::InvalidCredentials)
    ));
    assert!(!store_endpoint_credentials(
        directory.path(),
        &same,
        &same,
        String::new(),
        String::new()
    )
    .unwrap());
    assert!(get_credentials(directory.path(), same.endpoint().unwrap())
        .unwrap()
        .is_none());
}

#[test]
fn c7_new_provider_client_uses_saved_endpoint_without_mutating_existing_client() {
    use crate::models::{Config, Persisted};
    use crate::storage::LauncherState;
    let tmp = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/network-tests")
            .join(uuid::Uuid::new_v4().to_string()),
    ).unwrap();
    fn proxy() -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let mut socket = accept_or_timeout(&listener);
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut received = Vec::new();
            let mut byte = [0];
            while received.len() < 8192 && !received.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                received.push(byte[0]);
            }
            socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").unwrap();
            String::from_utf8(received).unwrap()
        });
        (port, worker)
    }
    let (port_a, a) = proxy();
    let (port_b, b) = proxy();
    let config = Config {
        game_directory: tmp.path().join("isolated-game").to_string_lossy().into_owned(),
        proxy_mode: "custom".into(),
        proxy_scheme: "http".into(),
        proxy_host: "127.0.0.1".into(),
        proxy_port: port_a,
        ..Config::default()
    };
    let state = LauncherState::test_fixture(tmp.path().to_path_buf(), Persisted {
        config: config.clone(), ..Persisted::default()
    }, crate::storage::test_client());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let _context = rt.enter();
    let before = crate::resources::client(&state, false).unwrap();
    let mut next = config;
    next.proxy_port = port_b;
    let saved = crate::commands::save_config_inner(&state, next).unwrap();
    assert_eq!(saved.proxy_port, port_b);
    let after = crate::resources::client(&state, false).unwrap();
    for (client, fixture) in [(&before, "before"), (&after, "after")] {
        let response = rt.block_on(client.head(format!("https://{fixture}.invalid/probe"))
            .timeout(Duration::from_secs(2)).send());
        assert!(response.is_err(), "proxy fixture must close the tunnel");
    }
    assert!(a.join().unwrap().starts_with("CONNECT before.invalid:443 HTTP/1.1\r\n"));
    assert!(b.join().unwrap().starts_with("CONNECT after.invalid:443 HTTP/1.1\r\n"));
}
