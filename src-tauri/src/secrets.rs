//! Per-user Windows DPAPI storage. No access/refresh token or service key belongs in state.json.
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Mutex};

pub trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

pub struct SecretStore {
    directory: PathBuf,
    lock: Mutex<()>,
}

impl SecretStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            directory: data_dir.join("secrets"),
            lock: Mutex::new(()),
        }
    }
    fn path(&self, key: &str) -> Result<PathBuf, String> {
        if key.is_empty() || key.len() > 1024 {
            return Err("凭据键无效".into());
        }
        Ok(self
            .directory
            .join(format!("{:x}.dpapi", Sha256::digest(key.as_bytes()))))
    }
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        <Self as SecretBackend>::get(self, key)
    }
    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        <Self as SecretBackend>::set(self, key, value)
    }
    pub fn remove(&self, key: &str) -> Result<(), String> {
        <Self as SecretBackend>::remove(self, key)
    }
}

impl SecretBackend for SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().map_err(|_| "凭据存储锁异常")?;
        let path = self.path(key)?;
        let ciphertext = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取加密凭据，请检查用户数据目录权限".into()),
        };
        let plain = unprotect(&ciphertext)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| "解密凭据格式无效，请重新登录".into())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "凭据存储锁异常")?;
        let path = self.path(key)?;
        let encrypted = protect(value.as_bytes())?;
        fs::create_dir_all(&self.directory).map_err(|_| "无法创建凭据目录")?;
        let temporary = self.directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result: Result<(), String> = (|| {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "无法创建凭据临时文件")?;
            file.write_all(&encrypted).map_err(|_| "无法写入加密凭据")?;
            file.sync_all().map_err(|_| "无法同步加密凭据")?;
            drop(file);
            fs::rename(&temporary, path).map_err(|_| "无法保存加密凭据".to_owned())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "凭据存储锁异常")?;
        match fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法删除加密凭据".into()),
        }
    }
}

pub fn load_service_secret(
    data_dir: &std::path::Path,
    key: &str,
) -> Result<Option<String>, String> {
    SecretStore::new(data_dir.to_owned()).get(&format!("service:{key}"))
}
pub fn save_service_secret(
    data_dir: &std::path::Path,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    let store = SecretStore::new(data_dir.to_owned());
    if secret.is_empty() {
        store.remove(&format!("service:{key}"))
    } else {
        store.set(&format!("service:{key}"), secret)
    }
}

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    length: u32,
    data: *mut u8,
}

#[cfg(windows)]
#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        output: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const DataBlob,
        description: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        output: *mut DataBlob,
    ) -> i32;
}
#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("凭据内容过大".into());
    }
    let input = DataBlob {
        length: bytes.len() as u32,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        length: 0,
        data: std::ptr::null_mut(),
    };
    // No LOCAL_MACHINE flag: the encrypted bytes are bound to this Windows user's DPAPI identity.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                1,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err("Windows 无法保护或解密凭据；请使用原 Windows 用户重新登录".into());
    }
    let result = unsafe {
        let result = std::slice::from_raw_parts(output.data, output.length as usize).to_vec();
        // Clear DPAPI-owned plaintext before returning its allocation to Windows.
        for index in 0..output.length as usize {
            std::ptr::write_volatile(output.data.add(index), 0);
        }
        LocalFree(output.data.cast());
        result
    };
    Ok(result)
}

#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    crypt(bytes, false)
}
#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("此构建尚未接入当前操作系统的系统凭据库，拒绝明文保存令牌".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("此构建尚未接入当前操作系统的系统凭据库".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_tamper_detection() {
        let secret = b"test-refresh-token-not-for-state-json";
        let mut encrypted = protect(secret).unwrap();
        assert!(!encrypted
            .windows(secret.len())
            .any(|window| window == secret));
        assert_eq!(unprotect(&encrypted).unwrap(), secret);
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(unprotect(&encrypted).is_err());
    }
    #[test]
    fn store_overwrite_and_delete_do_not_write_plaintext() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/auth-tests")
            .join(format!("launcher-dpapi-{}", uuid::Uuid::new_v4()));
        let store = SecretStore::new(root.clone());
        store.set("account:test", "first-private-value").unwrap();
        store
            .set("account:test", "replacement-private-value")
            .unwrap();
        assert_eq!(
            store.get("account:test").unwrap().as_deref(),
            Some("replacement-private-value")
        );
        let ciphertext = fs::read(store.path("account:test").unwrap()).unwrap();
        assert!(!ciphertext
            .windows(25)
            .any(|s| s == b"replacement-private-value"));
        store.remove("account:test").unwrap();
        assert!(store.get("account:test").unwrap().is_none());
        fs::remove_dir(root.join("secrets")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
