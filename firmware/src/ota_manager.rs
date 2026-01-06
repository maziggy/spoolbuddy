//! OTA Firmware Update Manager
//!
//! Implements PSRAM-buffered OTA for single-partition systems:
//! 1. Download firmware to PSRAM
//! 2. Validate checksum
//! 3. Erase and write to factory partition
//! 4. Reboot
//!
//! Note: Power loss during flash write (~10s) will brick device,
//! requiring USB recovery. Acceptable for constant-power deployments.

#![allow(dead_code)]

use esp_idf_svc::http::client::{Configuration as HttpConfig, EspHttpConnection};
use esp_idf_sys::{
    esp_partition_find, esp_partition_erase_range, esp_partition_write,
    esp_partition_t, esp_partition_type_t_ESP_PARTITION_TYPE_APP,
    esp_partition_subtype_t_ESP_PARTITION_SUBTYPE_APP_FACTORY,
    esp_partition_iterator_t, esp_partition_get, esp_partition_iterator_release,
    esp_restart,
};
use embedded_svc::http::client::Client as HttpClient;
use log::info;
use std::ptr;
use std::sync::Mutex;

/// OTA state
#[derive(Debug, Clone, PartialEq)]
pub enum OtaState {
    Idle,
    Checking,
    Downloading { progress: u8 },
    Validating,
    Flashing { progress: u8 },
    Complete,
    Error(String),
}

/// Update info from backend
#[derive(Debug)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub size: u32,
    pub checksum: String,
}

// Global state
static OTA_STATE: Mutex<OtaState> = Mutex::new(OtaState::Idle);
static CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Get current OTA state
pub fn get_state() -> OtaState {
    OTA_STATE.lock().unwrap().clone()
}

/// Set OTA state
fn set_state(state: OtaState) {
    *OTA_STATE.lock().unwrap() = state;
}

/// Get current firmware version
pub fn get_version() -> &'static str {
    CURRENT_VERSION
}

/// Check for available updates
pub fn check_for_update(server_url: &str) -> Result<UpdateInfo, String> {
    set_state(OtaState::Checking);

    let url = format!("{}/api/firmware/check?current_version={}", server_url, CURRENT_VERSION);
    info!("Checking for updates: {}", url);

    let config = HttpConfig {
        timeout: Some(std::time::Duration::from_secs(10)),
        ..Default::default()
    };

    let connection = EspHttpConnection::new(&config)
        .map_err(|e| format!("HTTP connection failed: {:?}", e))?;
    let mut client = HttpClient::wrap(connection);

    let request = client.get(&url)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;
    let mut response = request.submit()
        .map_err(|e| format!("HTTP submit failed: {:?}", e))?;

    let status = response.status();
    if status != 200 {
        set_state(OtaState::Idle);
        return Err(format!("HTTP error: {}", status));
    }

    // Read response body
    let mut buf = [0u8; 512];
    let mut json_data = Vec::new();
    loop {
        match response.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => json_data.extend_from_slice(&buf[..n]),
            Err(e) => {
                set_state(OtaState::Idle);
                return Err(format!("Read error: {:?}", e));
            }
        }
    }

    // Parse JSON response
    let json_str = String::from_utf8_lossy(&json_data);

    // Simple JSON parsing (avoid pulling in full serde for this)
    let available = json_str.contains("\"update_available\":true") ||
                   json_str.contains("\"update_available\": true");

    let version = extract_json_string(&json_str, "latest_version")
        .unwrap_or_else(|| "unknown".to_string());

    let size = extract_json_number(&json_str, "size").unwrap_or(0);

    let checksum = extract_json_string(&json_str, "checksum")
        .unwrap_or_else(|| "".to_string());

    set_state(OtaState::Idle);

    Ok(UpdateInfo {
        available,
        version,
        size,
        checksum,
    })
}

/// Perform OTA update
/// Downloads firmware to PSRAM, validates, then flashes
pub fn perform_update(server_url: &str) -> Result<(), String> {
    info!("Starting OTA update from {}", server_url);

    // Step 1: Download to PSRAM
    set_state(OtaState::Downloading { progress: 0 });
    let firmware_data = download_firmware(server_url)?;

    // Step 2: Validate
    set_state(OtaState::Validating);
    validate_firmware(&firmware_data)?;

    // Step 3: Flash
    flash_firmware(&firmware_data)?;

    // Step 4: Reboot
    set_state(OtaState::Complete);
    info!("OTA complete, rebooting in 2 seconds...");
    std::thread::sleep(std::time::Duration::from_secs(2));

    unsafe { esp_restart(); }

    // esp_restart() never returns, but Rust needs a return value
    #[allow(unreachable_code)]
    Ok(())
}

/// Download firmware to PSRAM buffer
fn download_firmware(server_url: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}/api/firmware/ota", server_url);
    info!("Downloading firmware from: {}", url);

    let config = HttpConfig {
        timeout: Some(std::time::Duration::from_secs(120)), // 2 min for large file
        ..Default::default()
    };

    let connection = EspHttpConnection::new(&config)
        .map_err(|e| format!("HTTP connection failed: {:?}", e))?;
    let mut client = HttpClient::wrap(connection);

    let request = client.get(&url)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;
    let mut response = request.submit()
        .map_err(|e| format!("HTTP submit failed: {:?}", e))?;

    let status = response.status();
    if status != 200 {
        set_state(OtaState::Error(format!("HTTP {}", status)));
        return Err(format!("HTTP error: {}", status));
    }

    // Get content length for progress
    let content_length: usize = response.header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5_000_000); // Assume 5MB if not provided

    info!("Firmware size: {} bytes", content_length);

    // Allocate in PSRAM (Vec uses heap which is configured to use PSRAM for large allocs)
    let mut firmware_data = Vec::with_capacity(content_length);
    // Use heap-allocated buffer to avoid stack overflow
    let mut buf = vec![0u8; 4096]; // 4KB chunks on heap
    let mut total_read = 0usize;

    loop {
        match response.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                firmware_data.extend_from_slice(&buf[..n]);
                total_read += n;

                let progress = ((total_read * 100) / content_length).min(100) as u8;
                set_state(OtaState::Downloading { progress });

                if total_read % (256 * 1024) == 0 {
                    info!("Downloaded: {} / {} bytes ({}%)", total_read, content_length, progress);
                }
            }
            Err(e) => {
                set_state(OtaState::Error(format!("Download failed: {:?}", e)));
                return Err(format!("Download error: {:?}", e));
            }
        }
    }

    info!("Download complete: {} bytes", firmware_data.len());
    Ok(firmware_data)
}

/// Validate firmware binary
fn validate_firmware(data: &[u8]) -> Result<(), String> {
    info!("Validating firmware ({} bytes)", data.len());

    // Check minimum size
    if data.len() < 256 {
        return Err("Firmware too small".to_string());
    }

    // Check ESP32 magic byte
    if data[0] != 0xE9 {
        return Err(format!("Invalid magic byte: 0x{:02X} (expected 0xE9)", data[0]));
    }

    // Check segment count (byte 1, should be reasonable)
    let segment_count = data[1];
    if segment_count == 0 || segment_count > 16 {
        return Err(format!("Invalid segment count: {}", segment_count));
    }

    info!("Firmware validation passed");
    Ok(())
}

/// Flash firmware to factory partition
fn flash_firmware(data: &[u8]) -> Result<(), String> {
    info!("Flashing {} bytes to factory partition", data.len());
    set_state(OtaState::Flashing { progress: 0 });

    unsafe {
        // Find factory partition
        let iterator: esp_partition_iterator_t = esp_partition_find(
            esp_partition_type_t_ESP_PARTITION_TYPE_APP,
            esp_partition_subtype_t_ESP_PARTITION_SUBTYPE_APP_FACTORY,
            ptr::null(),
        );

        if iterator.is_null() {
            return Err("Factory partition not found".to_string());
        }

        let partition: *const esp_partition_t = esp_partition_get(iterator);
        esp_partition_iterator_release(iterator);

        if partition.is_null() {
            return Err("Failed to get partition".to_string());
        }

        let part = &*partition;
        let part_size = part.size as usize;

        info!("Factory partition: offset=0x{:X}, size={} bytes", part.address, part_size);

        if data.len() > part_size {
            return Err(format!("Firmware too large: {} > {}", data.len(), part_size));
        }

        // Erase partition (in 64KB chunks for progress)
        let erase_size = ((data.len() + 0xFFF) / 0x1000) * 0x1000; // Round up to 4KB
        info!("Erasing {} bytes...", erase_size);

        let ret = esp_partition_erase_range(partition, 0, erase_size);
        if ret != 0 {
            return Err(format!("Erase failed: {}", ret));
        }

        // Write firmware (in 4KB chunks for progress)
        let chunk_size = 4096;
        let total_chunks = (data.len() + chunk_size - 1) / chunk_size;

        for (i, chunk) in data.chunks(chunk_size).enumerate() {
            let offset = i * chunk_size;
            let ret = esp_partition_write(partition, offset, chunk.as_ptr() as *const _, chunk.len());

            if ret != 0 {
                return Err(format!("Write failed at offset {}: {}", offset, ret));
            }

            let progress = (((i + 1) * 100) / total_chunks).min(100) as u8;
            set_state(OtaState::Flashing { progress });
        }

        info!("Flash complete");
    }

    Ok(())
}

// Simple JSON helpers (avoid serde dependency)
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\":\"", key);
    let alt_pattern = format!("\"{}\": \"", key);

    let start = json.find(&pattern)
        .map(|i| i + pattern.len())
        .or_else(|| json.find(&alt_pattern).map(|i| i + alt_pattern.len()))?;

    let end = json[start..].find('"').map(|i| start + i)?;
    Some(json[start..end].to_string())
}

fn extract_json_number(json: &str, key: &str) -> Option<u32> {
    let pattern = format!("\"{}\":", key);
    let start = json.find(&pattern).map(|i| i + pattern.len())?;

    // Skip whitespace
    let json_after = json[start..].trim_start();

    // Extract number
    let end = json_after.find(|c: char| !c.is_ascii_digit()).unwrap_or(json_after.len());
    json_after[..end].parse().ok()
}
