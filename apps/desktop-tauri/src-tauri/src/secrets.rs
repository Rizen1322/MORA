use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, path::Path, ptr};
use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB}};

fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    let data = CRYPT_INTEGER_BLOB { cbData: input.len().try_into().map_err(|_| "secret too large")?, pbData: input.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        if protect { CryptProtectData(&data, ptr::null(), ptr::null(), ptr::null(), ptr::null(), 1, &mut output) }
        else { CryptUnprotectData(&data, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), 1, &mut output) }
    };
    if ok == 0 { return Err("Windows could not unlock the provider key".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _); }
    Ok(result)
}

fn unlock(profile: &Path, data: &[u8]) -> Result<String, String> {
    let plain = if data.starts_with(b"v10") {
        if data.len() < 31 { return Err("Invalid encrypted provider key".into()); }
        let state: serde_json::Value = serde_json::from_slice(&fs::read(profile.join("Local State")).map_err(|_| "Chromium key is missing")?).map_err(|_| "Invalid Chromium state")?;
        let encoded = state["os_crypt"]["encrypted_key"].as_str().ok_or("Chromium key is missing")?;
        let wrapped = STANDARD.decode(encoded).map_err(|_| "Invalid Chromium key")?;
        if !wrapped.starts_with(b"DPAPI") { return Err("Unknown Chromium key format".into()); }
        let key = dpapi(&wrapped[5..], false)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "Invalid Chromium key length")?;
        cipher.decrypt(Nonce::from_slice(&data[3..15]), &data[15..]).map_err(|_| "Provider key authentication failed")?
    } else { dpapi(data, false)? };
    let key = String::from_utf8(plain).map_err(|_| "Invalid provider key")?;
    if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) { return Err("Invalid provider key".into()); }
    Ok(key)
}

pub fn read_existing_key(profile: &Path) -> Result<Option<String>, String> {
    let electron = profile.join("secret.bin");
    let own = profile.join("tauri-secret.bin");
    if electron.exists() {
        let key = unlock(profile, &fs::read(electron).map_err(|_| "Cannot read provider key")?)?;
        if own.exists() && unlock(profile, &fs::read(own).map_err(|_| "Cannot read provider key")?)? != key {
            return Err("Conflicting provider keys; existing keys were preserved".into());
        }
        return Ok(Some(key));
    }
    if own.exists() { return unlock(profile, &fs::read(own).map_err(|_| "Cannot read provider key")?).map(Some); }
    Ok(None)
}

pub fn secret_key(profile: &Path) -> Result<String, String> {
    if let Some(key) = read_existing_key(profile)? { return Ok(key); }
    let own = profile.join("tauri-secret.bin");
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "Cannot generate provider key")?;
    let key: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    fs::create_dir_all(profile).map_err(|_| "Cannot create profile")?;
    let encrypted = dpapi(key.as_bytes(), true)?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(own).map_err(|_| "Cannot save provider key")?;
    file.write_all(&encrypted).map_err(|_| "Cannot save provider key")?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    #[test]
    fn electron_44_profile() {
        let Some(profile) = std::env::var_os("MORA_SYNTHETIC_ELECTRON_PROFILE") else { return };
        let key = super::secret_key(std::path::Path::new(&profile)).unwrap();
        assert_eq!(key, "0123456789abcdef".repeat(4));
    }
}
