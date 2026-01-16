//! Scale Manager with C-callable interface
//!
//! Provides FFI functions for the C UI code to access scale data.
//! Uses shared I2C bus.
//! Calibration data is persisted to NVS flash.

use esp_idf_svc::nvs::{EspDefaultNvsPartition, EspNvs};
use log::{info, warn};
use std::sync::Mutex;

use crate::scale::nau7802::{self, Calibration, Nau7802State};
use crate::shared_i2c;

/// NVS namespace for scale calibration
const NVS_NAMESPACE: &str = "scale";
const NVS_KEY_CALIBRATION: &str = "cal";

/// Global scale state protected by mutex
static SCALE_STATE: Mutex<Option<Nau7802State>> = Mutex::new(None);

/// Global NVS partition for calibration persistence
static NVS_PARTITION: Mutex<Option<EspDefaultNvsPartition>> = Mutex::new(None);

/// Scale status for C code
#[repr(C)]
pub struct ScaleStatus {
    pub initialized: bool,
    pub weight_grams: f32,
    pub raw_value: i32,
    pub stable: bool,
    pub tare_offset: i32,
    pub cal_factor: f32,
}

/// Initialize NVS for scale calibration persistence
pub fn init_nvs(nvs: Option<EspDefaultNvsPartition>) {
    let mut guard = NVS_PARTITION.lock().unwrap();
    *guard = nvs;
    info!("Scale NVS initialized");
}

/// Initialize the scale manager with state (uses shared I2C)
pub fn init_scale_manager(mut state: Nau7802State) {
    // Try to load saved calibration from NVS
    if let Some(calibration) = load_calibration_from_nvs() {
        info!("Loaded saved calibration: zero_offset={}, cal_factor={}",
              calibration.zero_offset, calibration.cal_factor);
        state.calibration = calibration;
    } else {
        info!("No saved calibration found, using defaults");
    }

    let mut guard = SCALE_STATE.lock().unwrap();
    *guard = Some(state);
    info!("Scale manager initialized");
}

/// Load calibration data from NVS (8 bytes: i32 zero_offset + i32 cal_factor_x1000)
fn load_calibration_from_nvs() -> Option<Calibration> {
    let nvs_guard = NVS_PARTITION.lock().unwrap();
    let nvs_partition = nvs_guard.as_ref()?;

    let nvs = match EspNvs::new(nvs_partition.clone(), NVS_NAMESPACE, true) {
        Ok(nvs) => nvs,
        Err(e) => {
            warn!("Failed to open NVS namespace for scale: {:?}", e);
            return None;
        }
    };

    // Read calibration blob
    let mut buf = [0u8; 8];
    match nvs.get_blob(NVS_KEY_CALIBRATION, &mut buf) {
        Ok(Some(_)) => {
            // Parse the calibration data
            let zero_offset = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            let cal_factor_x1000 = i32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            let cal_factor = cal_factor_x1000 as f32 / 1000.0;

            Some(Calibration {
                zero_offset,
                cal_factor,
            })
        }
        Ok(None) => None, // No saved calibration
        Err(e) => {
            warn!("Failed to read calibration from NVS: {:?}", e);
            None
        }
    }
}

/// Save calibration data to NVS
fn save_calibration_to_nvs(calibration: &Calibration) -> bool {
    let nvs_guard = NVS_PARTITION.lock().unwrap();
    let Some(nvs_partition) = nvs_guard.as_ref() else {
        warn!("No NVS partition available for saving calibration");
        return false;
    };

    let mut nvs = match EspNvs::new(nvs_partition.clone(), NVS_NAMESPACE, true) {
        Ok(nvs) => nvs,
        Err(e) => {
            warn!("Failed to open NVS namespace for scale: {:?}", e);
            return false;
        }
    };

    // Pack calibration data into bytes
    let cal_factor_x1000 = (calibration.cal_factor * 1000.0) as i32;
    let mut buf = [0u8; 8];
    buf[0..4].copy_from_slice(&calibration.zero_offset.to_le_bytes());
    buf[4..8].copy_from_slice(&cal_factor_x1000.to_le_bytes());

    // Save as blob
    if let Err(e) = nvs.set_blob(NVS_KEY_CALIBRATION, &buf) {
        warn!("Failed to save calibration to NVS: {:?}", e);
        return false;
    }

    info!("Calibration saved to NVS: zero_offset={}, cal_factor={}",
          calibration.zero_offset, calibration.cal_factor);
    true
}

/// Poll the scale (call from main loop)
pub fn poll_scale() {
    let mut guard = SCALE_STATE.lock().unwrap();
    if let Some(ref mut state) = *guard {
        if state.initialized {
            let _ = shared_i2c::with_i2c(|i2c| {
                nau7802::read_weight(i2c, state)
            });
        }
    }
}

// =============================================================================
// C-callable FFI functions
// =============================================================================

/// Get current scale status
#[no_mangle]
pub extern "C" fn scale_get_status(status: *mut ScaleStatus) {
    if status.is_null() {
        return;
    }

    let guard = SCALE_STATE.lock().unwrap();
    let status = unsafe { &mut *status };

    if let Some(ref state) = *guard {
        status.initialized = state.initialized;
        status.weight_grams = state.weight_grams;
        status.raw_value = state.last_raw;
        status.stable = state.stable;
        status.tare_offset = state.calibration.zero_offset;
        status.cal_factor = state.calibration.cal_factor;
    } else {
        status.initialized = false;
        status.weight_grams = 0.0;
        status.raw_value = 0;
        status.stable = false;
        status.tare_offset = 0;
        status.cal_factor = 1.0;
    }
}

/// Get current weight in grams
#[no_mangle]
pub extern "C" fn scale_get_weight() -> f32 {
    let guard = SCALE_STATE.lock().unwrap();
    if let Some(ref state) = *guard {
        state.weight_grams
    } else {
        0.0
    }
}

/// Get raw ADC value
#[no_mangle]
pub extern "C" fn scale_get_raw() -> i32 {
    let guard = SCALE_STATE.lock().unwrap();
    if let Some(ref state) = *guard {
        state.last_raw
    } else {
        0
    }
}

/// Check if scale is initialized
#[no_mangle]
pub extern "C" fn scale_is_initialized() -> bool {
    let guard = SCALE_STATE.lock().unwrap();
    if let Some(ref state) = *guard {
        state.initialized
    } else {
        false
    }
}

/// Check if weight is stable
#[no_mangle]
pub extern "C" fn scale_is_stable() -> bool {
    let guard = SCALE_STATE.lock().unwrap();
    if let Some(ref state) = *guard {
        state.stable
    } else {
        false
    }
}

/// Tare the scale (set current weight as zero)
#[no_mangle]
pub extern "C" fn scale_tare() -> i32 {
    let mut guard = SCALE_STATE.lock().unwrap();
    if let Some(ref mut state) = *guard {
        let result = shared_i2c::with_i2c(|i2c| {
            nau7802::tare(i2c, state)
        });
        match result {
            Some(Ok(())) => {
                // Save calibration (includes tare offset) to NVS
                save_calibration_to_nvs(&state.calibration);
                0
            }
            _ => -1,
        }
    } else {
        -1
    }
}

/// Calibrate with a known weight (in grams)
#[no_mangle]
pub extern "C" fn scale_calibrate(known_weight_grams: f32) -> i32 {
    let mut guard = SCALE_STATE.lock().unwrap();
    if let Some(ref mut state) = *guard {
        let result = shared_i2c::with_i2c(|i2c| {
            nau7802::calibrate(i2c, state, known_weight_grams)
        });
        match result {
            Some(Ok(())) => {
                // Save calibration to NVS for persistence across restarts
                save_calibration_to_nvs(&state.calibration);
                0
            }
            _ => -1,
        }
    } else {
        -1
    }
}

/// Get tare offset
#[no_mangle]
pub extern "C" fn scale_get_tare_offset() -> i32 {
    let guard = SCALE_STATE.lock().unwrap();
    if let Some(ref state) = *guard {
        state.calibration.zero_offset
    } else {
        0
    }
}
