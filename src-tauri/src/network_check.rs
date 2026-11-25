use crate::{errors::AppResult, storage::LauncherState};
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs, UdpSocket},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;

const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_RESPONSE: u16 = 0x0101;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const STUN_TIMEOUT: Duration = Duration::from_millis(1200);
const STUN_ATTEMPTS_PER_ENDPOINT: usize = 2;
const TARGET_DISTINCT_ENDPOINTS: usize = 2;

/// Public STUN servers queried on demand only when the user runs a network check.
pub const STUN_ENDPOINTS: &[(&str, u16)] = &[
    ("stun.cloudflare.com", 3478),
    ("stun.miwifi.com", 3478),
    ("stun.l.google.com", 19302),
    ("stun1.l.google.com", 19302),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NatType {
    OpenInternet,
    EndpointIndependent,
    AddressPortDependent,
    BehindNat,
    Unreachable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ipv6Status {
    GlobalPublic,
    BehindNat6,
    LocalOnly,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdviceSeverity {
    Good,
    Info,
    Warn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAdvice {
    pub code: String,
    pub severity: AdviceSeverity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ipv4Report {
    pub available: bool,
    pub local_ip: Option<String>,
    pub public_ip: Option<String>,
    pub local_port: Option<u16>,
    pub mapped_port: Option<u16>,
    pub probes_succeeded: usize,
    pub rtt_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ipv6Report {
    pub status: Ipv6Status,
    pub local_ip: Option<String>,
    pub public_ip: Option<String>,
    pub mapped_port: Option<u16>,
    pub probes_succeeded: usize,
    pub rtt_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheckReport {
    pub checked_at: String,
    pub ipv4: Ipv4Report,
    pub ipv6: Ipv6Report,
    pub nat_type: NatType,
    pub cgnat_suspected: bool,
    pub direct_connect_ipv4: Option<String>,
    pub direct_connect_ipv6: Option<String>,
    pub stun_hosts_queried: Vec<String>,
    pub advice: Vec<NetworkAdvice>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProbeObservation {
    host: String,
    mapped: SocketAddr,
    rtt_ms: u64,
}

/// Build an RFC 5389 Binding Request (20-byte header, no attributes).
pub fn build_binding_request(tx_id: &[u8; 12]) -> [u8; 20] {
    let mut packet = [0u8; 20];
    packet[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    packet[2..4].copy_from_slice(&0u16.to_be_bytes());
    packet[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    packet[8..20].copy_from_slice(tx_id);
    packet
}

/// Parse an RFC 5389 Binding Success Response and return the reflected transport address.
/// Prefers `XOR-MAPPED-ADDRESS` (0x0020) over `MAPPED-ADDRESS` (0x0001).
pub fn parse_binding_response(packet: &[u8], expected_tx: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([packet[0], packet[1]]);
    let msg_len = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let cookie = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    if msg_type != STUN_BINDING_RESPONSE
        || cookie != STUN_MAGIC_COOKIE
        || &packet[8..20] != expected_tx
        || msg_len % 4 != 0
        || 20 + msg_len > packet.len()
    {
        return None;
    }

    let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
    let mut xor_mapped: Option<SocketAddr> = None;
    let mut plain_mapped: Option<SocketAddr> = None;
    let mut offset = 20usize;
    let end = 20 + msg_len;

    while offset + 4 <= end {
        let attr_type = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
        let attr_len = u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]) as usize;
        offset += 4;
        if offset + attr_len > end {
            break;
        }
        let value = &packet[offset..offset + attr_len];
        if attr_type == ATTR_XOR_MAPPED_ADDRESS {
            if let Some(addr) = decode_address_attr(value, true, &cookie_bytes, expected_tx) {
                xor_mapped = Some(addr);
            }
        } else if attr_type == ATTR_MAPPED_ADDRESS && plain_mapped.is_none() {
            plain_mapped = decode_address_attr(value, false, &cookie_bytes, expected_tx);
        }
        let padded = (attr_len + 3) & !3;
        offset = offset.saturating_add(padded);
    }

    xor_mapped.or(plain_mapped)
}

fn decode_address_attr(
    value: &[u8],
    xored: bool,
    cookie_bytes: &[u8; 4],
    tx_id: &[u8; 12],
) -> Option<SocketAddr> {
    if value.len() < 4 {
        return None;
    }
    let family = value[1];
    let raw_port = u16::from_be_bytes([value[2], value[3]]);
    let port = if xored {
        raw_port ^ (STUN_MAGIC_COOKIE >> 16) as u16
    } else {
        raw_port
    };
    match family {
        0x01 if value.len() >= 8 => {
            let mut octets = [value[4], value[5], value[6], value[7]];
            if xored {
                for i in 0..4 {
                    octets[i] ^= cookie_bytes[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(octets)), port))
        }
        0x02 if value.len() >= 20 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&value[4..20]);
            if xored {
                for i in 0..4 {
                    octets[i] ^= cookie_bytes[i];
                }
                for i in 0..12 {
                    octets[4 + i] ^= tx_id[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port))
        }
        _ => None,
    }
}

pub fn is_cgnat_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

pub fn is_public_v4(ip: Ipv4Addr) -> bool {
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || is_cgnat_v4(ip))
}

pub fn is_global_unicast_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    let segs = ip.segments();
    // Link-local fe80::/10
    if (segs[0] & 0xffc0) == 0xfe80 {
        return false;
    }
    // Unique local fc00::/7
    if (segs[0] & 0xfe00) == 0xfc00 {
        return false;
    }
    // Documentation 2001:db8::/32
    if segs[0] == 0x2001 && segs[1] == 0x0db8 {
        return false;
    }
    // IPv4-mapped ::ffff:0:0/96
    if ip.to_ipv4_mapped().is_some() {
        return false;
    }
    true
}

fn detect_local_ipv4() -> Option<Ipv4Addr> {
    for target in ["1.1.1.1:53", "223.5.5.5:53"] {
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(SocketAddr::V4(local)) = socket.local_addr() {
                    let ip = *local.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

fn detect_local_ipv6() -> Option<Ipv6Addr> {
    for target in ["[2606:4700:4700::1111]:53", "[2400:3200::1]:53"] {
        if let Ok(socket) = UdpSocket::bind("[::]:0") {
            if socket.connect(target).is_ok() {
                if let Ok(SocketAddr::V6(local)) = socket.local_addr() {
                    let ip = *local.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

fn new_transaction_id() -> [u8; 12] {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut tx = [0u8; 12];
    tx.copy_from_slice(&bytes[..12]);
    tx
}

fn probe_endpoint(socket: &UdpSocket, remote: SocketAddr) -> Option<(SocketAddr, u64)> {
    let mut buf = [0u8; 512];
    for _ in 0..STUN_ATTEMPTS_PER_ENDPOINT {
        let tx = new_transaction_id();
        let req = build_binding_request(&tx);
        let started = Instant::now();
        if socket.send_to(&req, remote).is_err() {
            return None;
        }
        // Drain stale packets until matching response or timeout.
        let deadline = started + STUN_TIMEOUT;
        while Instant::now() < deadline {
            match socket.recv_from(&mut buf) {
                Ok((len, _from)) => {
                    if let Some(mapped) = parse_binding_response(&buf[..len], &tx) {
                        let rtt = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                        return Some((mapped, rtt));
                    }
                }
                Err(_) => break,
            }
        }
    }
    None
}

fn run_family_probes(want_v6: bool) -> (Option<u16>, Vec<ProbeObservation>, Vec<String>) {
    let bind_addr = if want_v6 { "[::]:0" } else { "0.0.0.0:0" };
    let Ok(socket) = UdpSocket::bind(bind_addr) else {
        return (None, Vec::new(), Vec::new());
    };
    let _ = socket.set_read_timeout(Some(STUN_TIMEOUT));
    let _ = socket.set_write_timeout(Some(STUN_TIMEOUT));
    let local_port = socket.local_addr().ok().map(|addr| addr.port());

    let mut observations = Vec::new();
    let mut queried_hosts = Vec::new();
    let mut seen_remote_ips = HashSet::new();

    'outer: for &(host, port) in STUN_ENDPOINTS {
        let Ok(resolved) = (host, port).to_socket_addrs() else {
            continue;
        };
        let candidates: Vec<SocketAddr> = resolved
            .filter(|addr| addr.is_ipv6() == want_v6)
            .filter(|addr| seen_remote_ips.insert(addr.ip()))
            .take(2)
            .collect();
        if candidates.is_empty() {
            continue;
        }
        let endpoint_label = format!("{host}:{port}");
        if !queried_hosts.contains(&endpoint_label) {
            queried_hosts.push(endpoint_label.clone());
        }
        for remote in candidates {
            if let Some((mapped, rtt_ms)) = probe_endpoint(&socket, remote) {
                if mapped.is_ipv6() == want_v6 {
                    observations.push(ProbeObservation {
                        host: endpoint_label.clone(),
                        mapped,
                        rtt_ms,
                    });
                    if observations.len() >= TARGET_DISTINCT_ENDPOINTS {
                        break 'outer;
                    }
                    // Move to next distinct STUN host so mapping comparison spans different servers.
                    break;
                }
            }
        }
    }

    (local_port, observations, queried_hosts)
}

fn classify_ipv4_nat(
    local_ip: Option<Ipv4Addr>,
    local_port: Option<u16>,
    observations: &[ProbeObservation],
) -> (NatType, bool) {
    let cgnat_suspected = local_ip.is_some_and(is_cgnat_v4);
    let Some(first) = observations.first() else {
        return (NatType::Unreachable, cgnat_suspected);
    };
    let first_v4 = match first.mapped {
        SocketAddr::V4(addr) => addr,
        SocketAddr::V6(_) => return (NatType::Unreachable, cgnat_suspected),
    };

    if let (Some(local), Some(port)) = (local_ip, local_port) {
        if *first_v4.ip() == local && first_v4.port() == port && is_public_v4(local) {
            return (NatType::OpenInternet, false);
        }
    }

    if observations.len() >= 2 {
        let second = &observations[1];
        if first.mapped == second.mapped {
            (NatType::EndpointIndependent, cgnat_suspected)
        } else {
            (NatType::AddressPortDependent, cgnat_suspected)
        }
    } else {
        (NatType::BehindNat, cgnat_suspected)
    }
}

fn classify_ipv6(local_ip: Option<Ipv6Addr>, observations: &[ProbeObservation]) -> Ipv6Status {
    if let Some(first) = observations.first() {
        if let SocketAddr::V6(mapped) = first.mapped {
            if let Some(local) = local_ip {
                if is_global_unicast_v6(local) && *mapped.ip() == local {
                    return Ipv6Status::GlobalPublic;
                }
            }
            if is_global_unicast_v6(*mapped.ip()) {
                return Ipv6Status::BehindNat6;
            }
        }
    }
    if local_ip.is_some() {
        Ipv6Status::LocalOnly
    } else {
        Ipv6Status::Unavailable
    }
}

fn build_advice(
    nat_type: &NatType,
    cgnat_suspected: bool,
    ipv6_status: &Ipv6Status,
    custom_proxy_enabled: bool,
) -> Vec<NetworkAdvice> {
    let mut advice = Vec::new();
    match ipv6_status {
        Ipv6Status::GlobalPublic => advice.push(NetworkAdvice {
            code: "ipv6DirectReady".into(),
            severity: AdviceSeverity::Good,
        }),
        Ipv6Status::BehindNat6 => advice.push(NetworkAdvice {
            code: "ipv6BehindNat".into(),
            severity: AdviceSeverity::Info,
        }),
        Ipv6Status::LocalOnly | Ipv6Status::Unavailable => advice.push(NetworkAdvice {
            code: "ipv6Unavailable".into(),
            severity: AdviceSeverity::Info,
        }),
    }

    match nat_type {
        NatType::OpenInternet => advice.push(NetworkAdvice {
            code: "ipv4OpenDirect".into(),
            severity: AdviceSeverity::Good,
        }),
        NatType::EndpointIndependent => advice.push(NetworkAdvice {
            code: "ipv4ConeForward".into(),
            severity: AdviceSeverity::Info,
        }),
        NatType::AddressPortDependent => advice.push(NetworkAdvice {
            code: "ipv4SymmetricWarn".into(),
            severity: AdviceSeverity::Warn,
        }),
        NatType::BehindNat => advice.push(NetworkAdvice {
            code: "ipv4BehindNatSingleProbe".into(),
            severity: AdviceSeverity::Info,
        }),
        NatType::Unreachable => advice.push(NetworkAdvice {
            code: "ipv4Unavailable".into(),
            severity: AdviceSeverity::Warn,
        }),
    }

    if cgnat_suspected {
        advice.push(NetworkAdvice {
            code: "ipv4CgnatDetected".into(),
            severity: AdviceSeverity::Warn,
        });
    }

    if custom_proxy_enabled {
        advice.push(NetworkAdvice {
            code: "proxyDirectUdpNote".into(),
            severity: AdviceSeverity::Info,
        });
    }

    advice
}

fn assemble_report(
    local_v4: Option<Ipv4Addr>,
    local_port_v4: Option<u16>,
    v4_obs: Vec<ProbeObservation>,
    local_v6: Option<Ipv6Addr>,
    v6_obs: Vec<ProbeObservation>,
    mut stun_hosts_queried: Vec<String>,
    custom_proxy_enabled: bool,
) -> NetworkCheckReport {
    let (nat_type, cgnat_suspected) = classify_ipv4_nat(local_v4, local_port_v4, &v4_obs);
    let ipv6_status = classify_ipv6(local_v6, &v6_obs);

    let v4_first = v4_obs.first();
    let v4_public_ip = v4_first.map(|o| o.mapped.ip().to_string());
    let v4_mapped_port = v4_first.map(|o| o.mapped.port());
    let v4_rtt = v4_obs.iter().map(|o| o.rtt_ms).min();

    let v6_first = v6_obs.first();
    let v6_public_ip = v6_first.map(|o| o.mapped.ip().to_string());
    let v6_mapped_port = v6_first.map(|o| o.mapped.port());
    let v6_rtt = v6_obs.iter().map(|o| o.rtt_ms).min();

    let direct_connect_ipv4 = match (&nat_type, &v4_public_ip) {
        (NatType::OpenInternet | NatType::EndpointIndependent, Some(ip)) if !cgnat_suspected => {
            Some(format!("{ip}:25565"))
        }
        _ => None,
    };
    let direct_connect_ipv6 = match (&ipv6_status, &v6_public_ip) {
        (Ipv6Status::GlobalPublic, Some(ip)) => Some(format!("[{ip}]:25565")),
        _ => None,
    };

    if stun_hosts_queried.is_empty() {
        stun_hosts_queried = STUN_ENDPOINTS
            .iter()
            .map(|(h, p)| format!("{h}:{p}"))
            .collect();
    } else {
        let mut seen = HashSet::new();
        stun_hosts_queried.retain(|host| seen.insert(host.clone()));
    }

    let advice = build_advice(&nat_type, cgnat_suspected, &ipv6_status, custom_proxy_enabled);

    NetworkCheckReport {
        checked_at: Utc::now().to_rfc3339(),
        ipv4: Ipv4Report {
            available: !v4_obs.is_empty(),
            local_ip: local_v4.map(|ip| ip.to_string()),
            public_ip: v4_public_ip,
            local_port: local_port_v4,
            mapped_port: v4_mapped_port,
            probes_succeeded: v4_obs.len(),
            rtt_ms: v4_rtt,
        },
        ipv6: Ipv6Report {
            status: ipv6_status,
            local_ip: local_v6.map(|ip| ip.to_string()),
            public_ip: v6_public_ip,
            mapped_port: v6_mapped_port,
            probes_succeeded: v6_obs.len(),
            rtt_ms: v6_rtt,
        },
        nat_type,
        cgnat_suspected,
        direct_connect_ipv4,
        direct_connect_ipv6,
        stun_hosts_queried,
        advice,
    }
}

pub(crate) fn run_network_check_blocking(custom_proxy_enabled: bool) -> NetworkCheckReport {
    let local_v4 = detect_local_ipv4();
    let local_v6 = detect_local_ipv6();
    let ((local_port_v4, v4_obs, v4_hosts), (_local_port_v6, v6_obs, v6_hosts)) =
        std::thread::scope(|scope| {
            let h4 = scope.spawn(|| run_family_probes(false));
            let h6 = scope.spawn(|| run_family_probes(true));
            (
                h4.join().unwrap_or((None, Vec::new(), Vec::new())),
                h6.join().unwrap_or((None, Vec::new(), Vec::new())),
            )
        });
    let mut hosts = v4_hosts;
    hosts.extend(v6_hosts);
    assemble_report(
        local_v4,
        local_port_v4,
        v4_obs,
        local_v6,
        v6_obs,
        hosts,
        custom_proxy_enabled,
    )
}

#[tauri::command]
pub async fn check_network_environment(
    state: State<'_, Arc<LauncherState>>,
) -> AppResult<NetworkCheckReport> {
    let custom_proxy_enabled = state
        .snapshot()
        .map(|data| data.config.proxy_mode.eq_ignore_ascii_case("custom"))
        .unwrap_or(false);
    let report =
        tokio::task::spawn_blocking(move || run_network_check_blocking(custom_proxy_enabled))
            .await
            .map_err(|error| format!("网络检测任务意外中止：{error}"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{SocketAddrV4, SocketAddrV6};

    fn build_xor_mapped_v4_response(tx: &[u8; 12], ip: Ipv4Addr, port: u16) -> Vec<u8> {
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        pkt.extend_from_slice(&12u16.to_be_bytes()); // 4 attr header + 8 value
        pkt.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        pkt.extend_from_slice(tx);
        pkt.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        pkt.extend_from_slice(&8u16.to_be_bytes());
        pkt.push(0x00);
        pkt.push(0x01); // IPv4
        let xport = port ^ (STUN_MAGIC_COOKIE >> 16) as u16;
        pkt.extend_from_slice(&xport.to_be_bytes());
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let octets = ip.octets();
        for i in 0..4 {
            pkt.push(octets[i] ^ cookie[i]);
        }
        pkt
    }

    fn build_xor_mapped_v6_response(tx: &[u8; 12], ip: Ipv6Addr, port: u16) -> Vec<u8> {
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        pkt.extend_from_slice(&24u16.to_be_bytes()); // 4 attr header + 20 value
        pkt.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        pkt.extend_from_slice(tx);
        pkt.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        pkt.extend_from_slice(&20u16.to_be_bytes());
        pkt.push(0x00);
        pkt.push(0x02); // IPv6
        let xport = port ^ (STUN_MAGIC_COOKIE >> 16) as u16;
        pkt.extend_from_slice(&xport.to_be_bytes());
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let octets = ip.octets();
        for i in 0..4 {
            pkt.push(octets[i] ^ cookie[i]);
        }
        for i in 0..12 {
            pkt.push(octets[4 + i] ^ tx[i]);
        }
        pkt
    }

    #[test]
    fn stun_binding_request_and_response_roundtrip_v4_and_v6() {
        let tx = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let req = build_binding_request(&tx);
        assert_eq!(req.len(), 20);
        assert_eq!(&req[0..2], &STUN_BINDING_REQUEST.to_be_bytes());
        assert_eq!(&req[4..8], &STUN_MAGIC_COOKIE.to_be_bytes());
        assert_eq!(&req[8..20], &tx);

        let v4_ip = Ipv4Addr::new(198, 51, 100, 42);
        let resp_v4 = build_xor_mapped_v4_response(&tx, v4_ip, 51234);
        assert_eq!(
            parse_binding_response(&resp_v4, &tx),
            Some(SocketAddr::V4(SocketAddrV4::new(v4_ip, 51234)))
        );

        let v6_ip: Ipv6Addr = "2001:4860:4860::8888".parse().unwrap();
        let resp_v6 = build_xor_mapped_v6_response(&tx, v6_ip, 60001);
        assert_eq!(
            parse_binding_response(&resp_v6, &tx),
            Some(SocketAddr::V6(SocketAddrV6::new(v6_ip, 60001, 0, 0)))
        );

        // Wrong transaction ID or truncated packet must be rejected.
        let wrong_tx = [0u8; 12];
        assert_eq!(parse_binding_response(&resp_v4, &wrong_tx), None);
        assert_eq!(parse_binding_response(&resp_v4[..19], &tx), None);
    }

    #[test]
    fn stun_parser_prefers_xor_mapped_and_falls_back_to_plain_mapped() {
        let tx = [0xAA; 12];
        let plain_ip = Ipv4Addr::new(192, 0, 2, 10);
        let xor_ip = Ipv4Addr::new(198, 51, 100, 77);
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        pkt.extend_from_slice(&24u16.to_be_bytes());
        pkt.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        pkt.extend_from_slice(&tx);
        // Plain MAPPED-ADDRESS first
        pkt.extend_from_slice(&ATTR_MAPPED_ADDRESS.to_be_bytes());
        pkt.extend_from_slice(&8u16.to_be_bytes());
        pkt.extend_from_slice(&[0x00, 0x01]);
        pkt.extend_from_slice(&40000u16.to_be_bytes());
        pkt.extend_from_slice(&plain_ip.octets());
        // Plain-only packet decodes plain IP
        let mut plain_only = pkt.clone();
        plain_only[2..4].copy_from_slice(&12u16.to_be_bytes());
        assert_eq!(
            parse_binding_response(&plain_only, &tx),
            Some(SocketAddr::V4(SocketAddrV4::new(plain_ip, 40000)))
        );
        // Append XOR-MAPPED-ADDRESS; parser must prefer it.
        pkt.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        pkt.extend_from_slice(&8u16.to_be_bytes());
        pkt.extend_from_slice(&[0x00, 0x01]);
        pkt.extend_from_slice(&(40001u16 ^ (STUN_MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        for i in 0..4 {
            pkt.push(xor_ip.octets()[i] ^ cookie[i]);
        }
        assert_eq!(
            parse_binding_response(&pkt, &tx),
            Some(SocketAddr::V4(SocketAddrV4::new(xor_ip, 40001)))
        );
    }

    #[test]
    fn classifies_nat_types_and_cgnat_accurately() {
        assert!(!is_public_v4(Ipv4Addr::new(198, 51, 100, 9)));
        let pub_ip = Ipv4Addr::new(1, 1, 1, 1);
        assert!(is_public_v4(pub_ip));
        let obs_a = ProbeObservation {
            host: "a".into(),
            mapped: SocketAddr::new(IpAddr::V4(pub_ip), 50000),
            rtt_ms: 15,
        };
        let obs_b_same = ProbeObservation {
            host: "b".into(),
            mapped: SocketAddr::new(IpAddr::V4(pub_ip), 50000),
            rtt_ms: 20,
        };
        let obs_b_diff_port = ProbeObservation {
            host: "b".into(),
            mapped: SocketAddr::new(IpAddr::V4(pub_ip), 50001),
            rtt_ms: 20,
        };

        assert_eq!(
            classify_ipv4_nat(Some(pub_ip), Some(50000), &[obs_a.clone(), obs_b_same.clone()]),
            (NatType::OpenInternet, false)
        );
        assert_eq!(
            classify_ipv4_nat(
                Some(Ipv4Addr::new(192, 168, 1, 20)),
                Some(50000),
                &[obs_a.clone(), obs_b_same.clone()]
            ),
            (NatType::EndpointIndependent, false)
        );
        assert_eq!(
            classify_ipv4_nat(
                Some(Ipv4Addr::new(192, 168, 1, 20)),
                Some(50000),
                &[obs_a.clone(), obs_b_diff_port]
            ),
            (NatType::AddressPortDependent, false)
        );
        assert_eq!(
            classify_ipv4_nat(
                Some(Ipv4Addr::new(100, 64, 0, 5)),
                Some(50000),
                &[obs_a.clone(), obs_b_same]
            ),
            (NatType::EndpointIndependent, true)
        );
        assert_eq!(
            classify_ipv4_nat(Some(Ipv4Addr::new(192, 168, 1, 20)), Some(50000), &[obs_a]),
            (NatType::BehindNat, false)
        );
        assert_eq!(
            classify_ipv4_nat(Some(Ipv4Addr::new(192, 168, 1, 20)), Some(50000), &[]),
            (NatType::Unreachable, false)
        );
    }

    #[test]
    fn classifies_ipv6_and_assembles_direct_connect_advice() {
        let global_v6: Ipv6Addr = "2409:8a00:1234::42".parse().unwrap();
        let link_local_v6: Ipv6Addr = "fe80::1".parse().unwrap();
        let ula_v6: Ipv6Addr = "fd12:3456::1".parse().unwrap();
        assert!(is_global_unicast_v6(global_v6));
        assert!(!is_global_unicast_v6(link_local_v6));
        assert!(!is_global_unicast_v6(ula_v6));

        let v6_obs = vec![ProbeObservation {
            host: "stun.cloudflare.com:3478".into(),
            mapped: SocketAddr::new(IpAddr::V6(global_v6), 54321),
            rtt_ms: 18,
        }];
        let report = assemble_report(
            Some(Ipv4Addr::new(192, 168, 1, 10)),
            Some(50000),
            vec![
                ProbeObservation {
                    host: "stun.cloudflare.com:3478".into(),
                    mapped: SocketAddr::new(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 2)), 61000),
                    rtt_ms: 25,
                },
                ProbeObservation {
                    host: "stun.miwifi.com:3478".into(),
                    mapped: SocketAddr::new(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 2)), 61001),
                    rtt_ms: 30,
                },
            ],
            Some(global_v6),
            v6_obs,
            vec!["stun.cloudflare.com:3478".into(), "stun.miwifi.com:3478".into()],
            true,
        );

        assert_eq!(report.nat_type, NatType::AddressPortDependent);
        assert_eq!(report.ipv6.status, Ipv6Status::GlobalPublic);
        assert_eq!(report.direct_connect_ipv4, None);
        assert_eq!(
            report.direct_connect_ipv6.as_deref(),
            Some("[2409:8a00:1234::42]:25565")
        );
        let codes: Vec<&str> = report.advice.iter().map(|item| item.code.as_str()).collect();
        assert!(codes.contains(&"ipv6DirectReady"));
        assert!(codes.contains(&"ipv4SymmetricWarn"));
        assert!(codes.contains(&"proxyDirectUdpNote"));
    }

    #[test]
    fn loopback_stun_server_roundtrips_over_udp_socket() {
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        let server_addr = server.local_addr().unwrap();
        server.set_read_timeout(Some(Duration::from_secs(2))).unwrap();

        let handle = std::thread::spawn(move || {
            let mut buf = [0u8; 128];
            let (len, peer) = server.recv_from(&mut buf).unwrap();
            assert_eq!(len, 20);
            let mut tx = [0u8; 12];
            tx.copy_from_slice(&buf[8..20]);
            let resp = build_xor_mapped_v4_response(
                &tx,
                match peer.ip() {
                    IpAddr::V4(ip) => ip,
                    IpAddr::V6(_) => unreachable!(),
                },
                peer.port(),
            );
            server.send_to(&resp, peer).unwrap();
        });

        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let client_addr = client.local_addr().unwrap();
        let (mapped, _rtt) = probe_endpoint(&client, server_addr).expect("loopback STUN response");
        assert_eq!(mapped, client_addr);
        handle.join().unwrap();
    }
}
