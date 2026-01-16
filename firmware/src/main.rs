//! SpoolBuddy Firmware
//! ESP32-S3 with ELECROW CrowPanel 7.0" (800x480 RGB565)
//! Using LVGL 9.x with EEZ Studio generated UI

use esp_idf_hal::delay::FreeRtos;
use esp_idf_hal::gpio::PinDriver;
use esp_idf_hal::i2c::{I2cConfig, I2cDriver};
use esp_idf_hal::peripherals::Peripherals;
use esp_idf_hal::spi::{SpiDeviceDriver, SpiDriver, SpiDriverConfig, config::Config as SpiConfig};
use esp_idf_hal::units::Hertz;
use esp_idf_svc::eventloop::EspSystemEventLoop;
use esp_idf_svc::nvs::EspDefaultNvsPartition;
use esp_idf_sys as _;
use log::{info, warn};

// Scale module for NAU7802
mod scale;

// Scale manager with C-callable interface
mod scale_manager;

// NFC module for PN5180 and I2C bridge
mod nfc;

// Shared I2C bus for scale and NFC
mod shared_i2c;

// NFC bridge manager (Pico I2C bridge)
mod nfc_bridge_manager;

// WiFi manager with C-callable interface
mod wifi_manager;

// Backend client for server communication
mod backend_client;

// Time manager for NTP sync
mod time_manager;

// OTA update manager
mod ota_manager;

// Direct SPI NFC disabled - now using I2C bridge via Pico
const NFC_ENABLED: bool = false;

// Display driver C functions (handles LVGL init and EEZ UI)
extern "C" {
    fn display_init() -> i32;
    fn display_tick();
    fn display_set_backlight_hw(brightness_percent: u8);
}

// =============================================================================
// Display Settings FFI (called from C UI code)
// =============================================================================

static mut DISPLAY_BRIGHTNESS: u8 = 80;
static mut DISPLAY_TIMEOUT: u16 = 300;

#[no_mangle]
pub extern "C" fn display_set_brightness(brightness: u8) {
    let brightness = if brightness > 100 { 100 } else { brightness };
    unsafe {
        DISPLAY_BRIGHTNESS = brightness;
        // Actually set hardware backlight via I2C
        display_set_backlight_hw(brightness);
    }
    info!("Display brightness set to {}%", brightness);
}

#[no_mangle]
pub extern "C" fn display_get_brightness() -> u8 {
    unsafe { DISPLAY_BRIGHTNESS }
}

#[no_mangle]
pub extern "C" fn display_set_timeout(timeout_seconds: u16) {
    unsafe {
        DISPLAY_TIMEOUT = timeout_seconds;
    }
    info!("Display timeout set to {} seconds", timeout_seconds);
}

#[no_mangle]
pub extern "C" fn display_get_timeout() -> u16 {
    unsafe { DISPLAY_TIMEOUT }
}

fn main() {
    // Initialize ESP-IDF
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("SpoolBuddy Firmware starting...");

    // ==========================================================================
    // EARLY GPIO4/5/6 DIAGNOSTIC - Check MCU_SEL before ANY initialization
    // ==========================================================================
    // ==========================================================================
    // TEST UART0-OUT: GPIO43 -> GPIO44 loopback
    // ==========================================================================
    info!("=== UART0-OUT LOOPBACK TEST (GPIO43 -> GPIO44) ===");
    unsafe {
        // GPIO43 and GPIO44 are in the upper bank (32-48)
        // GPIO_OUT1_REG: 0x60004010 (bits 0-15 = GPIO 32-47)
        // GPIO_IN1_REG: 0x60004044
        // GPIO_ENABLE1_REG: 0x6000402C
        // GPIO43 = bit 11, GPIO44 = bit 12

        // Set MCU_SEL=0 for GPIO43 and GPIO44
        // IO_MUX for GPIO43: 0x60009000 + 43*4 = 0x600090AC
        // IO_MUX for GPIO44: 0x60009000 + 44*4 = 0x600090B0
        let iomux43 = core::ptr::read_volatile(0x600090AC as *const u32);
        let iomux44 = core::ptr::read_volatile(0x600090B0 as *const u32);
        info!("  GPIO43 IO_MUX=0x{:08X} MCU_SEL={}", iomux43, (iomux43 >> 12) & 0x7);
        info!("  GPIO44 IO_MUX=0x{:08X} MCU_SEL={}", iomux44, (iomux44 >> 12) & 0x7);

        // Force MCU_SEL=0
        core::ptr::write_volatile(0x600090AC as *mut u32, iomux43 & !0x7000);
        core::ptr::write_volatile(0x600090B0 as *mut u32, iomux44 & !0x7000);

        // Enable GPIO43 as output
        let gpio_enable1 = core::ptr::read_volatile(0x6000402C as *const u32);
        core::ptr::write_volatile(0x6000402C as *mut u32, gpio_enable1 | (1 << 11));  // GPIO43 = bit 11

        // Set GPIO matrix for GPIO43 output
        core::ptr::write_volatile((0x60004554 + 43*4) as *mut u32, 0x100);

        // Configure GPIO44 as input with FUN_IE enabled
        let iomux44_in = core::ptr::read_volatile(0x600090B0 as *const u32);
        core::ptr::write_volatile(0x600090B0 as *mut u32, iomux44_in | (1 << 9));  // FUN_IE = bit 9

        // Disable output on GPIO44
        let gpio_enable1 = core::ptr::read_volatile(0x6000402C as *const u32);
        core::ptr::write_volatile(0x6000402C as *mut u32, gpio_enable1 & !(1 << 12));  // GPIO44 = bit 12

        // Toggle GPIO43 and read GPIO44
        let gpio_out1 = core::ptr::read_volatile(0x60004010 as *const u32);

        // Set HIGH
        core::ptr::write_volatile(0x60004010 as *mut u32, gpio_out1 | (1 << 11));
        for _ in 0..1000 { core::hint::spin_loop(); }
        let in_high = core::ptr::read_volatile(0x60004044 as *const u32);
        let gpio44_high = (in_high >> 12) & 1;

        // Set LOW
        core::ptr::write_volatile(0x60004010 as *mut u32, gpio_out1 & !(1 << 11));
        for _ in 0..1000 { core::hint::spin_loop(); }
        let in_low = core::ptr::read_volatile(0x60004044 as *const u32);
        let gpio44_low = (in_low >> 12) & 1;

        info!("  GPIO43=HIGH -> GPIO44={}", gpio44_high);
        info!("  GPIO43=LOW  -> GPIO44={}", gpio44_low);

        if gpio44_high == 1 && gpio44_low == 0 {
            info!("  *** UART0-OUT LOOPBACK WORKS! ***");
        } else {
            info!("  UART0-OUT loopback FAILED");
        }
    }
    info!("=== UART0-OUT TEST DONE ===");

    let peripherals = Peripherals::take().unwrap();

    // Initialize WiFi subsystem (must be done before display init uses I2C0)
    let sysloop = EspSystemEventLoop::take().expect("Failed to take system event loop");
    let nvs = EspDefaultNvsPartition::take().ok();

    // Clone NVS partition for scale calibration persistence
    let nvs_for_scale = nvs.clone();

    match wifi_manager::init_wifi_system(peripherals.modem, sysloop, nvs) {
        Ok(_) => info!("WiFi subsystem ready"),
        Err(e) => warn!("WiFi init failed: {}", e),
    }

    // Initialize scale NVS (for calibration persistence)
    scale_manager::init_nvs(nvs_for_scale);

    // Initialize backend client (for server communication)
    backend_client::init();

    // Initialize display, LVGL, and EEZ UI via C driver
    // Display uses I2C0 (GPIO15/16) for touch controller
    unsafe {
        info!("Initializing display and UI...");
        let result = display_init();
        if result != 0 {
            info!("Display init failed with code: {}", result);
        }
    }

    // Initialize shared I2C bus on UART1-OUT port
    // UART1-OUT pinout: IO19-RX1, IO20-TX1, 3V3, GND
    // Using: GPIO19=SDA, GPIO20=SCL
    // This bus is shared between scale (NAU7802) and NFC bridge (Pico at 0x55)
    info!("=== SHARED I2C INIT (UART1-OUT: GPIO19/20) ===");
    let i2c1_config = I2cConfig::new().baudrate(Hertz(100_000));
    match I2cDriver::new(
        peripherals.i2c1,
        peripherals.pins.gpio19,  // SDA (UART1-OUT IO19-RX1)
        peripherals.pins.gpio20,  // SCL (UART1-OUT IO20-TX1)
        &i2c1_config,
    ) {
        Ok(i2c) => {
            info!("I2C1 initialized (SDA=GPIO19, SCL=GPIO20 on UART1-OUT)");

            // Leak the I2C driver to get 'static lifetime
            let i2c_static: &'static mut I2cDriver<'static> = Box::leak(Box::new(i2c));

            // Scan I2C1 for devices
            info!("Scanning I2C1 bus...");
            let mut found_nau7802 = false;
            let mut found_pico = false;
            for addr in 0x08..0x78 {
                let mut buf = [0u8; 1];
                if i2c_static.read(addr, &mut buf, 100).is_ok() {
                    info!("  Found I2C device at 0x{:02X}", addr);
                    if addr == scale::nau7802::NAU7802_ADDR {
                        info!("  -> NAU7802 scale chip detected!");
                        found_nau7802 = true;
                    }
                    if addr == nfc::i2c_bridge::PICO_NFC_ADDR {
                        info!("  -> Pico NFC bridge detected!");
                        found_pico = true;
                    }
                }
            }
            if !found_nau7802 {
                warn!("  NAU7802 not found at 0x{:02X}", scale::nau7802::NAU7802_ADDR);
            }
            if !found_pico {
                warn!("  Pico NFC bridge not found at 0x{:02X}", nfc::i2c_bridge::PICO_NFC_ADDR);
            }

            // Initialize scale if found
            if found_nau7802 {
                let mut scale_state = scale::nau7802::Nau7802State::new();
                match scale::nau7802::init(i2c_static, &mut scale_state) {
                    Ok(()) => {
                        info!("NAU7802 scale initialized");
                        scale_manager::init_scale_manager(scale_state);
                    }
                    Err(e) => warn!("NAU7802 init failed: {:?}", e),
                }
            }

            // Take ownership back and give to shared_i2c
            let i2c_owned = unsafe { Box::from_raw(i2c_static as *mut I2cDriver<'static>) };
            shared_i2c::init_shared_i2c(*i2c_owned);

            // Initialize NFC bridge manager (uses shared I2C)
            if found_pico {
                if nfc_bridge_manager::init_nfc_manager() {
                    info!("NFC bridge manager initialized");
                } else {
                    warn!("NFC bridge manager init failed");
                }
            }
        }
        Err(e) => {
            warn!("I2C1 init failed: {:?}", e);
        }
    }
    info!("=== SHARED I2C DONE ===");

    // ==========================================================================
    // Direct PN5180 SPI NFC - DISABLED (using I2C bridge via Pico instead)
    // ==========================================================================
    if NFC_ENABLED {
    // Working config from commit c27f680:
    // SPI pins on J9 header:
    //   - IO5 (J9 Pin 2) -> SCK
    //   - IO4 (J9 Pin 3) -> MISO
    //   - IO6 (J9 Pin 4) -> MOSI
    // Control pins on J11 header:
    //   - IO8 (J11 Pin 6) -> NSS (chip select)
    // BUSY/RST not used
    info!("=== NFC SPI INIT ===");
    info!("Using pins: SCK=GPIO5, MISO=GPIO4, MOSI=GPIO6, NSS=GPIO8");

    // Quick GPIO sanity check for J9 pins
    info!("=== GPIO SANITY CHECK ===");
    {
        use esp_idf_hal::gpio::Pull;

        // Test GPIO4 (MISO) - should float high with pull-up
        let gpio4_test = PinDriver::input(peripherals.pins.gpio4, Pull::Up).unwrap();
        FreeRtos::delay_ms(5);
        let miso_state = gpio4_test.is_high();
        info!("  GPIO4 (MISO) with pull-up: {}", if miso_state { "HIGH (good)" } else { "LOW (check wiring!)" });
        drop(gpio4_test);

        // Test GPIO5 (SCK) and GPIO6 (MOSI) as outputs
        let mut gpio5_test = PinDriver::output(peripherals.pins.gpio5).unwrap();
        let mut gpio6_test = PinDriver::output(peripherals.pins.gpio6).unwrap();

        gpio5_test.set_high().unwrap();
        gpio6_test.set_high().unwrap();
        FreeRtos::delay_ms(1);
        info!("  GPIO5 (SCK) and GPIO6 (MOSI) configured as outputs");

        gpio5_test.set_low().unwrap();
        gpio6_test.set_low().unwrap();
        drop(gpio5_test);
        drop(gpio6_test);
    }
    info!("=== GPIO SANITY CHECK DONE ===");

    // ==========================================================================
    // BIT-BANG SPI TEST - Tests physical wiring before SPI peripheral init
    // ==========================================================================
    // This test manually toggles GPIO pins to verify physical connections
    // to the PN5180, bypassing the ESP32's SPI peripheral entirely.
    // J9 pins: SCK=GPIO5, MISO=GPIO4, MOSI=GPIO6, NSS=GPIO8
    info!("=== BIT-BANG SPI TEST ===");
    info!("This test manually toggles GPIOs to verify physical wiring.");
    info!("Pins: SCK=GPIO5, MISO=GPIO4, MOSI=GPIO6, NSS=GPIO8");
    {
        use esp_idf_hal::gpio::Pull;

        // Steal the pins for bit-bang test
        let gpio5_bb = unsafe { esp_idf_hal::gpio::Gpio5::steal() };
        let gpio4_bb = unsafe { esp_idf_hal::gpio::Gpio4::steal() };
        let gpio6_bb = unsafe { esp_idf_hal::gpio::Gpio6::steal() };
        let gpio8_bb = unsafe { esp_idf_hal::gpio::Gpio8::steal() };

        // Configure pins:
        // - GPIO5 (SCK) = output
        // - GPIO6 (MOSI) = output
        // - GPIO4 (MISO) = input with pull-up
        // - GPIO8 (NSS) = output
        let mut sck = PinDriver::output(gpio5_bb).unwrap();
        let mut mosi = PinDriver::output(gpio6_bb).unwrap();
        let miso = PinDriver::input(gpio4_bb, Pull::Up).unwrap();
        let mut nss = PinDriver::output(gpio8_bb).unwrap();

        // Initial state: SCK low, MOSI low, NSS high
        sck.set_low().unwrap();
        mosi.set_low().unwrap();
        nss.set_high().unwrap();
        FreeRtos::delay_ms(10);

        info!("Initial state: SCK=LOW, MOSI=LOW, NSS=HIGH");
        info!("  MISO reads: {}", if miso.is_high() { "HIGH (floating with pull-up)" } else { "LOW" });

        // Test 1: Toggle NSS and check MISO
        info!("Test BB-1: NSS toggle test");
        nss.set_low().unwrap();
        FreeRtos::delay_ms(5);
        let miso_nss_low = miso.is_high();
        info!("  NSS=LOW  -> MISO={}", if miso_nss_low { "HIGH" } else { "LOW" });

        nss.set_high().unwrap();
        FreeRtos::delay_ms(5);
        let miso_nss_high = miso.is_high();
        info!("  NSS=HIGH -> MISO={}", if miso_nss_high { "HIGH" } else { "LOW" });

        // Test 2: Bit-bang a READ_EEPROM command for firmware version
        // PN5180 protocol: send [0x07, 0x10, 0x02] to read 2 bytes from EEPROM addr 0x10
        info!("Test BB-2: Bit-bang READ_EEPROM command");
        info!("  Sending: [0x07, 0x10, 0x02] (READ_EEPROM, addr=0x10, len=2)");

        // Macro to bit-bang one byte (MSB first, SPI Mode 0)
        macro_rules! bitbang_byte {
            ($sck:expr, $mosi:expr, $miso:expr, $byte:expr) => {{
                let byte: u8 = $byte;
                let mut rx = 0u8;
                for i in 0..8 {
                    // Set MOSI for next bit (MSB first)
                    if (byte >> (7 - i)) & 1 == 1 {
                        $mosi.set_high().unwrap();
                    } else {
                        $mosi.set_low().unwrap();
                    }
                    // Small delay for setup time
                    for _ in 0..10 { core::hint::spin_loop(); }

                    // Rising edge of SCK - sample MISO
                    $sck.set_high().unwrap();
                    // Small delay
                    for _ in 0..10 { core::hint::spin_loop(); }
                    // Sample MISO
                    if $miso.is_high() {
                        rx |= 1 << (7 - i);
                    }

                    // Falling edge of SCK
                    $sck.set_low().unwrap();
                    // Small delay
                    for _ in 0..10 { core::hint::spin_loop(); }
                }
                rx
            }};
        }

        // Cycle 1: Send command
        nss.set_low().unwrap();
        FreeRtos::delay_ms(2);

        let cmd = [0x07u8, 0x10, 0x02];
        let mut rx_cmd = [0u8; 3];
        for (i, &b) in cmd.iter().enumerate() {
            rx_cmd[i] = bitbang_byte!(sck, mosi, miso, b);
        }
        info!("  TX: {:02X?}", cmd);
        info!("  RX during TX: {:02X?}", rx_cmd);

        nss.set_high().unwrap();
        FreeRtos::delay_ms(30); // Wait for PN5180 to process

        // Cycle 2: Read response
        nss.set_low().unwrap();
        FreeRtos::delay_ms(2);

        let mut response = [0u8; 2];
        for i in 0..2 {
            response[i] = bitbang_byte!(sck, mosi, miso, 0xFFu8);
        }
        info!("  Response: {:02X?}", response);

        nss.set_high().unwrap();

        // Analyze results
        if response == [0xFF, 0xFF] {
            info!("  Result: All 0xFF - PN5180 not responding");
            info!("  -> Physical wiring issue OR PN5180 not powered/damaged");
        } else if response == [0x00, 0x00] {
            info!("  Result: All 0x00 - MISO shorted to GND");
        } else {
            info!("  Result: Got data! Firmware version bytes: {:02X?}", response);
            let major = response[1] >> 4;
            let minor = response[1] & 0x0F;
            let patch = response[0];
            info!("  Decoded: FW {}.{}.{}", major, minor, patch);
            if major > 0 || minor > 0 || patch > 0 {
                info!("  *** BIT-BANG SUCCESS! Physical wiring is correct! ***");
            }
        }

        // Test 3: SCK toggle test - verify SCK is actually reaching PN5180
        info!("Test BB-3: SCK activity test");
        nss.set_low().unwrap();
        FreeRtos::delay_ms(1);

        info!("  Toggling SCK 8 times, watching MISO...");
        let mut miso_states = [0u8; 8];
        for i in 0..8 {
            sck.set_high().unwrap();
            for _ in 0..5 { core::hint::spin_loop(); }
            miso_states[i] = if miso.is_high() { 1 } else { 0 };
            sck.set_low().unwrap();
            for _ in 0..5 { core::hint::spin_loop(); }
        }
        info!("  MISO during SCK toggles: {:?}", miso_states);

        let all_same = miso_states.iter().all(|&x| x == miso_states[0]);
        if all_same {
            info!("  MISO stayed {} - PN5180 not seeing clock or not responding",
                if miso_states[0] == 1 { "HIGH" } else { "LOW" });
        } else {
            info!("  MISO changed during clock - PN5180 is responding!");
        }

        nss.set_high().unwrap();

        // Test 4: GPIO pin verification
        info!("");
        info!("Test BB-4: GPIO OUTPUT VERIFICATION");
        info!("  Testing if GPIO5 (SCK) and GPIO6 (MOSI) can actually drive output...");

        // ESP32-S3 Register addresses:
        // GPIO_OUT_REG: 0x60004004 - output level
        // GPIO_ENABLE_REG: 0x60004020 - output enable (must be 1 for output)
        // GPIO_IN_REG: 0x6000403C - input level (reads physical pin)
        // IO_MUX_GPIOn_REG: 0x60009000 + n*4 - pin function select
        //   MCU_SEL field (bits 14:12): 0=GPIO, 1/2/3=peripheral
        // GPIO_FUNCn_OUT_SEL_CFG_REG: 0x60004554 + n*4 - GPIO matrix output select
        //   0x100 = GPIO output from GPIO_OUT register

        // Check GPIO_ENABLE register
        let gpio_enable: u32;
        unsafe {
            gpio_enable = core::ptr::read_volatile(0x60004020 as *const u32);
        }
        info!("  GPIO_ENABLE: GPIO4={} GPIO5={} GPIO6={} GPIO8={}",
            (gpio_enable >> 4) & 1, (gpio_enable >> 5) & 1,
            (gpio_enable >> 6) & 1, (gpio_enable >> 8) & 1);

        // Check IO_MUX configuration for GPIO4, 5, 6
        let iomux4: u32;
        let iomux5: u32;
        let iomux6: u32;
        let iomux8: u32;
        unsafe {
            iomux4 = core::ptr::read_volatile(0x60009010 as *const u32); // GPIO4
            iomux5 = core::ptr::read_volatile(0x60009014 as *const u32); // GPIO5
            iomux6 = core::ptr::read_volatile(0x60009018 as *const u32); // GPIO6
            iomux8 = core::ptr::read_volatile(0x60009020 as *const u32); // GPIO8
        }
        info!("  IO_MUX: GPIO4=0x{:08X} (MCU_SEL={})", iomux4, (iomux4 >> 12) & 0x7);
        info!("  IO_MUX: GPIO5=0x{:08X} (MCU_SEL={})", iomux5, (iomux5 >> 12) & 0x7);
        info!("  IO_MUX: GPIO6=0x{:08X} (MCU_SEL={})", iomux6, (iomux6 >> 12) & 0x7);
        info!("  IO_MUX: GPIO8=0x{:08X} (MCU_SEL={})", iomux8, (iomux8 >> 12) & 0x7);

        // Check GPIO matrix output selection
        let funcout4: u32;
        let funcout5: u32;
        let funcout6: u32;
        let funcout8: u32;
        unsafe {
            funcout4 = core::ptr::read_volatile((0x60004554 + 4*4) as *const u32);
            funcout5 = core::ptr::read_volatile((0x60004554 + 5*4) as *const u32);
            funcout6 = core::ptr::read_volatile((0x60004554 + 6*4) as *const u32);
            funcout8 = core::ptr::read_volatile((0x60004554 + 8*4) as *const u32);
        }
        info!("  GPIO_FUNC_OUT_SEL: GPIO4=0x{:03X} GPIO5=0x{:03X} GPIO6=0x{:03X} GPIO8=0x{:03X}",
            funcout4 & 0x1FF, funcout5 & 0x1FF, funcout6 & 0x1FF, funcout8 & 0x1FF);
        info!("    (0x100=GPIO output, other values=peripheral)");

        // GPIO5 and GPIO6 are in GPIO_OUT (bits 0-31)
        let gpio_out_before: u32;
        unsafe {
            gpio_out_before = core::ptr::read_volatile(0x60004004 as *const u32);
        }
        info!("  GPIO_OUT before: SCK(5)={} MOSI(6)={}", (gpio_out_before >> 5) & 1, (gpio_out_before >> 6) & 1);

        // Set both HIGH
        sck.set_high().unwrap();
        mosi.set_high().unwrap();
        FreeRtos::delay_ms(1);
        let gpio_out_high: u32;
        let gpio_in_high: u32;
        unsafe {
            gpio_out_high = core::ptr::read_volatile(0x60004004 as *const u32);
            gpio_in_high = core::ptr::read_volatile(0x6000403C as *const u32);
        }
        info!("  Set HIGH: SCK_OUT={} SCK_IN={}, MOSI_OUT={} MOSI_IN={}",
            (gpio_out_high >> 5) & 1, (gpio_in_high >> 5) & 1,
            (gpio_out_high >> 6) & 1, (gpio_in_high >> 6) & 1);

        // Set both LOW
        sck.set_low().unwrap();
        mosi.set_low().unwrap();
        FreeRtos::delay_ms(1);
        let gpio_out_low: u32;
        let gpio_in_low: u32;
        unsafe {
            gpio_out_low = core::ptr::read_volatile(0x60004004 as *const u32);
            gpio_in_low = core::ptr::read_volatile(0x6000403C as *const u32);
        }
        info!("  Set LOW:  SCK_OUT={} SCK_IN={}, MOSI_OUT={} MOSI_IN={}",
            (gpio_out_low >> 5) & 1, (gpio_in_low >> 5) & 1,
            (gpio_out_low >> 6) & 1, (gpio_in_low >> 6) & 1);

        // Check if GPIO_OUT actually changed
        let sck_out_works = ((gpio_out_high >> 5) & 1) != ((gpio_out_low >> 5) & 1);
        let mosi_out_works = ((gpio_out_high >> 6) & 1) != ((gpio_out_low >> 6) & 1);
        let sck_in_works = ((gpio_in_high >> 5) & 1) != ((gpio_in_low >> 5) & 1);
        let mosi_in_works = ((gpio_in_high >> 6) & 1) != ((gpio_in_low >> 6) & 1);

        info!("  GPIO_OUT changes: SCK={} MOSI={}",
            if sck_out_works { "YES" } else { "NO!" },
            if mosi_out_works { "YES" } else { "NO!" });
        info!("  GPIO_IN  changes: SCK={} MOSI={}",
            if sck_in_works { "YES" } else { "NO!" },
            if mosi_in_works { "YES" } else { "NO!" });

        if !sck_out_works || !mosi_out_works {
            info!("");
            info!("  *** GPIO OUTPUT REGISTER NOT CHANGING! ***");
            info!("  The PinDriver::set_high/set_low is not working.");
        }

        if sck_out_works && !sck_in_works {
            info!("");
            info!("  *** SCK: GPIO_OUT changes but GPIO_IN doesn't! ***");
            info!("  Check GPIO5 wiring on J9 header.");
        }

        if mosi_out_works && !mosi_in_works {
            info!("");
            info!("  *** MOSI: GPIO_OUT changes but GPIO_IN doesn't! ***");
            info!("  Check GPIO6 wiring on J9 header.");
        }

        // Test 5: SCK -> MISO loopback test (if wired)
        info!("");
        info!("Test BB-5: SCK -> MISO loopback test");
        info!("  (If you shorted SCK to MISO, this tests if SCK output works)");

        // Toggle SCK while watching MISO
        let mut sck_loopback_works = true;
        for i in 0..4 {
            let expected = i % 2 == 0; // alternate HIGH/LOW
            if expected {
                sck.set_high().unwrap();
            } else {
                sck.set_low().unwrap();
            }
            FreeRtos::delay_ms(2);
            let actual = miso.is_high();
            info!("  SCK={} -> MISO={} {}",
                if expected { "HIGH" } else { "LOW" },
                if actual { "HIGH" } else { "LOW" },
                if expected == actual { "✓" } else { "✗ MISMATCH" });
            if expected != actual {
                sck_loopback_works = false;
            }
        }
        sck.set_low().unwrap();

        if sck_loopback_works {
            info!("  *** SCK -> MISO LOOPBACK WORKS! GPIO5 is functional! ***");
        } else {
            info!("  SCK loopback failed - wire not connected or GPIO5 issue");
        }

        // Test 6: MOSI -> MISO loopback test (if wired)
        info!("");
        info!("Test BB-6: MOSI -> MISO loopback test");
        info!("  (If you shorted MOSI to MISO, this tests if MOSI output works)");

        let mut mosi_loopback_works = true;
        for i in 0..4 {
            let expected = i % 2 == 0;
            if expected {
                mosi.set_high().unwrap();
            } else {
                mosi.set_low().unwrap();
            }
            FreeRtos::delay_ms(2);
            let actual = miso.is_high();
            info!("  MOSI={} -> MISO={} {}",
                if expected { "HIGH" } else { "LOW" },
                if actual { "HIGH" } else { "LOW" },
                if expected == actual { "✓" } else { "✗ MISMATCH" });
            if expected != actual {
                mosi_loopback_works = false;
            }
        }
        mosi.set_low().unwrap();

        if mosi_loopback_works {
            info!("  *** MOSI -> MISO LOOPBACK WORKS! GPIO6 is functional! ***");
        } else {
            info!("  MOSI loopback failed - wire not connected or GPIO6 issue");
        }

        // Summary
        info!("");
        info!("=== LOOPBACK TEST SUMMARY ===");
        if mosi_loopback_works && !sck_loopback_works {
            info!("MOSI works but SCK doesn't - check GPIO5 on J9 header!");
        } else if sck_loopback_works && !mosi_loopback_works {
            info!("SCK works but MOSI doesn't - check GPIO6 on J9 header!");
        } else if sck_loopback_works && mosi_loopback_works {
            info!("Both SCK and MOSI loopbacks work - GPIO pins are functional!");
            info!("If PN5180 still doesn't respond, check:");
            info!("  - NSS (GPIO8) connection to PN5180");
            info!("  - VCC/GND power to PN5180");
            info!("  - PN5180 module itself");
        } else {
            info!("Neither loopback worked - check wire connections:");
            info!("  SCK  = GPIO5 on J9 Pin 2");
            info!("  MOSI = GPIO6 on J9 Pin 4");
            info!("  MISO = GPIO4 on J9 Pin 3");

            // Try forcing GPIO output via direct register writes
            info!("");
            info!("=== FORCING GPIO OUTPUT VIA REGISTERS ===");

            // Force GPIO function (MCU_SEL=0), output enable, and pull-up
            unsafe {
                // For GPIO5: set MCU_SEL=0, FUN_IE=0 (disable input), FUN_WPU=0
                // IO_MUX register format: bit 9 = FUN_IE, bits 14:12 = MCU_SEL
                let iomux5_val = 0x00000000u32; // Pure GPIO, no pulls, no input
                core::ptr::write_volatile(0x60009014 as *mut u32, iomux5_val);

                // Same for GPIO6
                let iomux6_val = 0x00000000u32;
                core::ptr::write_volatile(0x60009018 as *mut u32, iomux6_val);

                // Enable output for GPIO5 and GPIO6
                let enable = core::ptr::read_volatile(0x60004020 as *const u32);
                core::ptr::write_volatile(0x60004020 as *mut u32, enable | (1 << 5) | (1 << 6));

                // Set GPIO matrix to output from GPIO_OUT register (0x100)
                core::ptr::write_volatile((0x60004554 + 5*4) as *mut u32, 0x100);
                core::ptr::write_volatile((0x60004554 + 6*4) as *mut u32, 0x100);

                // Toggle GPIO5 via GPIO_OUT register directly
                info!("  Direct register toggle of GPIO5/6...");
                let out_reg = 0x60004004 as *mut u32;
                let in_reg = 0x6000403C as *const u32;

                // Set GPIO5 HIGH, GPIO6 LOW
                let current = core::ptr::read_volatile(out_reg);
                core::ptr::write_volatile(out_reg, (current | (1 << 5)) & !(1 << 6));
                FreeRtos::delay_ms(5);
                let in_val1 = core::ptr::read_volatile(in_reg);
                info!("    OUT: GPIO5=1 GPIO6=0 -> IN: GPIO5={} GPIO6={}",
                    (in_val1 >> 5) & 1, (in_val1 >> 6) & 1);

                // Set GPIO5 LOW, GPIO6 HIGH
                let current = core::ptr::read_volatile(out_reg);
                core::ptr::write_volatile(out_reg, (current & !(1 << 5)) | (1 << 6));
                FreeRtos::delay_ms(5);
                let in_val2 = core::ptr::read_volatile(in_reg);
                info!("    OUT: GPIO5=0 GPIO6=1 -> IN: GPIO5={} GPIO6={}",
                    (in_val2 >> 5) & 1, (in_val2 >> 6) & 1);

                // Check if input follows output now
                let gpio5_works = ((in_val1 >> 5) & 1) == 1 && ((in_val2 >> 5) & 1) == 0;
                let gpio6_works = ((in_val1 >> 6) & 1) == 0 && ((in_val2 >> 6) & 1) == 1;

                if gpio5_works && gpio6_works {
                    info!("  *** DIRECT REGISTER WRITE WORKS! ***");
                    info!("  PinDriver has a configuration issue.");
                } else if !gpio5_works && !gpio6_works {
                    info!("  Direct register write FAILED - pins not connected to J9!");
                    info!("  These GPIOs may be used internally by the display.");
                } else {
                    info!("  Partial success: GPIO5={} GPIO6={}",
                        if gpio5_works { "works" } else { "FAIL" },
                        if gpio6_works { "works" } else { "FAIL" });
                }
            }
        }

        // Release pins so they can be used by SPI
        drop(sck);
        drop(mosi);
        drop(miso);
        drop(nss);
    }
    info!("=== BIT-BANG TEST DONE ===");

    // Re-take the pins for SPI (they were consumed by the GPIO test)
    let gpio5 = unsafe { esp_idf_hal::gpio::Gpio5::steal() };  // SCK
    let gpio4 = unsafe { esp_idf_hal::gpio::Gpio4::steal() };  // MISO
    let gpio6 = unsafe { esp_idf_hal::gpio::Gpio6::steal() };  // MOSI

    // Enable internal pull-up on MISO (GPIO4) to prevent floating
    info!("Enabling internal pull-up on MISO (GPIO4) via IO_MUX...");
    unsafe {
        // ESP32-S3 IO_MUX register addresses: Base: 0x60009000
        // GPIO4 IO_MUX is at offset 0x14 (4 * 4 + some offset)
        let io_mux_gpio4 = 0x60009000 + 0x14;
        let current = core::ptr::read_volatile(io_mux_gpio4 as *const u32);
        // Bit 8 = FUN_WPU (pull-up), Bit 7 = FUN_WPD (pull-down)
        let new_val = (current | (1 << 8)) & !(1 << 7);  // Enable pull-up, disable pull-down
        core::ptr::write_volatile(io_mux_gpio4 as *mut u32, new_val);
        info!("  GPIO4 IO_MUX @ 0x{:08X}: 0x{:08X} -> 0x{:08X}", io_mux_gpio4, current, new_val);

        // Check GPIO_ENABLE_REG to see if something is driving GPIO4 as output
        let gpio_enable = 0x60004020 as *const u32;  // GPIO_ENABLE_REG (GPIO0-31)
        let gpio_enable_val = core::ptr::read_volatile(gpio_enable);
        let gpio4_is_output = (gpio_enable_val >> 4) & 1;
        info!("  GPIO_ENABLE_REG: 0x{:08X} (GPIO4 output={})", gpio_enable_val, gpio4_is_output);

        // Check GPIO_IN_REG to see the actual pin state
        let gpio_in = 0x6000403C as *const u32;  // GPIO_IN_REG (GPIO0-31)
        let gpio_in_val = core::ptr::read_volatile(gpio_in);
        let gpio4_level = (gpio_in_val >> 4) & 1;
        info!("  GPIO_IN_REG: 0x{:08X} (GPIO4 level={})", gpio_in_val, gpio4_level);
    }

    // Initialize SPI bus using SPI3 with J9 pins
    let spi_driver = match SpiDriver::new(
        peripherals.spi3,
        gpio5,  // SCK
        gpio6,  // MOSI
        Some(gpio4),  // MISO
        &SpiDriverConfig::default(),
    ) {
        Ok(driver) => {
            info!("SPI3 bus initialized (SCK=GPIO5, MOSI=GPIO6, MISO=GPIO4)");

            // Check GPIO state AFTER SPI initialization
            info!("=== GPIO STATE AFTER SPI INIT ===");
            unsafe {
                // Check SPI pins: GPIO5=SCK, GPIO4=MISO, GPIO6=MOSI, GPIO8=NSS

                // GPIO_ENABLE (0-31) - which pins are outputs
                let gpio_enable_val = core::ptr::read_volatile(0x60004020 as *const u32);
                info!("  GPIO_ENABLE: 0x{:08X}", gpio_enable_val);
                info!("    GPIO5(SCK)={} GPIO4(MISO)={} GPIO6(MOSI)={} GPIO8(NSS)={}",
                    (gpio_enable_val >> 5) & 1,
                    (gpio_enable_val >> 4) & 1,
                    (gpio_enable_val >> 6) & 1,
                    (gpio_enable_val >> 8) & 1);

                // GPIO_OUT - what values are being driven
                let gpio_out_val = core::ptr::read_volatile(0x60004004 as *const u32);
                info!("  GPIO_OUT: 0x{:08X}", gpio_out_val);

                // Check FUNC_OUT_SEL for each pin (which peripheral signal is routed)
                let gpio5_out = core::ptr::read_volatile((0x60004554 + 5*4) as *const u32);
                let gpio4_out = core::ptr::read_volatile((0x60004554 + 4*4) as *const u32);
                let gpio6_out = core::ptr::read_volatile((0x60004554 + 6*4) as *const u32);
                let gpio8_out = core::ptr::read_volatile((0x60004554 + 8*4) as *const u32);
                info!("  FUNC_OUT_SEL: GPIO5=0x{:02X} GPIO4=0x{:02X} GPIO6=0x{:02X} GPIO8=0x{:02X}",
                    gpio5_out & 0x1FF, gpio4_out & 0x1FF, gpio6_out & 0x1FF, gpio8_out & 0x1FF);
                info!("    Expected: GPIO5=SPICLK GPIO6=SPID GPIO4=input");

                // Check SPI3 peripheral registers
                // ESP32-S3: SPI2=0x60024000, SPI3=0x60025000
                // Offsets: CMD=0x00, ADDR=0x04, CTRL=0x08, CLOCK=0x0C, USER=0x10, MISC=0x3C
                let spi3_base = 0x60025000;

                // SPI_CLOCK_REG - clock configuration (offset 0x0C!)
                let spi_clk = core::ptr::read_volatile((spi3_base + 0x0C) as *const u32);
                info!("  SPI3_CLOCK: 0x{:08X}", spi_clk);

                // SPI_USER_REG - user config
                let spi_user = core::ptr::read_volatile((spi3_base + 0x10) as *const u32);
                info!("  SPI3_USER: 0x{:08X}", spi_user);

                // SPI_MISC_REG - might have loopback or other issues (offset 0x3C)
                let spi_misc = core::ptr::read_volatile((spi3_base + 0x3C) as *const u32);
                info!("  SPI3_MISC: 0x{:08X}", spi_misc);

                // Check GPIO_IN to see actual pin states
                let gpio_in_val = core::ptr::read_volatile(0x6000403C as *const u32);
                info!("  GPIO_IN: 0x{:08X}", gpio_in_val);
                info!("    GPIO5={} GPIO4={} GPIO6={} GPIO8={}",
                    (gpio_in_val >> 5) & 1,
                    (gpio_in_val >> 4) & 1,
                    (gpio_in_val >> 6) & 1,
                    (gpio_in_val >> 8) & 1);
            }
            info!("=== END GPIO STATE ===");

            // FIX: The esp-idf-hal SPI driver may misconfigure GPIO pins AND
            // may not enable the SPI3 peripheral clock!
            info!("=== FIXING SPI3 PERIPHERAL ===");
            unsafe {
                // ESP32-S3 SPI clock enable is in PERIP_CLK_EN0, not PERIP_CLK_EN1!
                // SYSTEM_PERIP_CLK_EN0_REG = 0x6002600C
                // Bit 6 = SPI2_CLK_EN
                // Bit 7 = SPI3_CLK_EN
                let perip_clk_en0 = 0x6002600C as *mut u32;
                let current_clk0 = core::ptr::read_volatile(perip_clk_en0);
                let new_clk0 = current_clk0 | (1 << 7);  // Enable SPI3 clock (bit 7)
                core::ptr::write_volatile(perip_clk_en0, new_clk0);
                info!("  PERIP_CLK_EN0: was 0x{:08X}, now 0x{:08X} (SPI3=bit7)", current_clk0, new_clk0);

                // Also check PERIP_CLK_EN1 (bit 23 might be something else)
                let perip_clk_en1 = 0x60026010 as *mut u32;
                let current_clk1 = core::ptr::read_volatile(perip_clk_en1);
                let new_clk1 = current_clk1 | (1 << 23);  // Enable whatever is at bit 23
                core::ptr::write_volatile(perip_clk_en1, new_clk1);
                info!("  PERIP_CLK_EN1: was 0x{:08X}, now 0x{:08X} (bit23)", current_clk1, new_clk1);

                // Clear SPI3 peripheral reset in PERIP_RST_EN0
                // SYSTEM_PERIP_RST_EN0_REG = 0x60026020
                // Bit 7 = SPI3_RST (1=in reset, 0=not reset)
                let perip_rst_en0 = 0x60026020 as *mut u32;
                let current_rst0 = core::ptr::read_volatile(perip_rst_en0);
                let new_rst0 = current_rst0 & !(1 << 7);  // Clear SPI3 reset
                core::ptr::write_volatile(perip_rst_en0, new_rst0);
                info!("  PERIP_RST_EN0: was 0x{:08X}, now 0x{:08X} (SPI3=bit7)", current_rst0, new_rst0);

                // Also clear in PERIP_RST_EN1 just in case
                let perip_rst_en1 = 0x60026024 as *mut u32;
                let current_rst1 = core::ptr::read_volatile(perip_rst_en1);
                let new_rst1 = current_rst1 & !(1 << 23);
                core::ptr::write_volatile(perip_rst_en1, new_rst1);
                info!("  PERIP_RST_EN1: was 0x{:08X}, now 0x{:08X} (bit23)", current_rst1, new_rst1);

                // Check SPI3 base registers after clock enable
                // ESP32-S3: SPI2=0x60024000, SPI3=0x60025000
                // Offsets: CMD=0x00, ADDR=0x04, CTRL=0x08, CLOCK=0x0C, USER=0x10
                let spi3_base = 0x60025000;
                let spi_clk_before = core::ptr::read_volatile((spi3_base + 0x0C) as *const u32);
                info!("  SPI3 CLOCK reg before manual config: 0x{:08X}", spi_clk_before);

                // If SPI3 registers are still zero, manually configure basic settings
                // For 1 MHz SPI with 80 MHz APB clock:
                // CLKCNT_N = 79, CLKCNT_H = 39, CLKCNT_L = 79, CLKDIV_PRE = 0
                // SPI_CLK_REG = (39 << 6) | (79 << 0) | (79 << 12) | (0 << 18) | (0 << 31)
                //             = 0x0004F9CF
                if spi_clk_before == 0 {
                    info!("  SPI3 registers are zero - configuring manually!");

                    // Configure clock divider for ~1 MHz
                    // APB clock is 80 MHz, so divide by 80 for 1 MHz
                    let clk_val: u32 = (79 << 0)   // CLKCNT_L
                                     | (39 << 6)   // CLKCNT_H
                                     | (79 << 12)  // CLKCNT_N
                                     | (0 << 18);  // CLKDIV_PRE
                    core::ptr::write_volatile((spi3_base + 0x0C) as *mut u32, clk_val);  // CLOCK at 0x0C!
                    info!("  SPI3_CLOCK set to: 0x{:08X}", clk_val);

                    // Configure SPI_USER for Mode 0
                    // USR_MOSI = 1 (bit 27), USR_MISO = 1 (bit 28)
                    // CK_OUT_EDGE = 0 (sample on rising), CS_SETUP = 1, CS_HOLD = 1
                    let user_val: u32 = (1 << 27)   // USR_MOSI
                                      | (1 << 28)   // USR_MISO
                                      | (1 << 7)    // CS_SETUP
                                      | (1 << 8);   // CS_HOLD
                    core::ptr::write_volatile((spi3_base + 0x10) as *mut u32, user_val);
                    info!("  SPI3_USER set to: 0x{:08X}", user_val);
                }
            }

            info!("=== FIXING SPI3 GPIO ROUTING ===");
            unsafe {
                // ESP32-S3 GP-SPI3 signal numbers from gpio_sig_map.h:
                // SPI3_CLK_OUT_IDX = 66 (SCK output)
                // SPI3_Q_IN_IDX = 67 (MISO input)
                // SPI3_D_OUT_IDX = 68 (MOSI output)
                //
                // J9 pin assignments (working config from c27f680):
                // GPIO5 = SCK, GPIO4 = MISO, GPIO6 = MOSI

                // 1. Fix GPIO4 (MISO) - make it input, route to SPI3_Q_IN (signal 67)
                let gpio_enable_w1tc = 0x60004028 as *mut u32;  // GPIO_ENABLE_W1TC
                core::ptr::write_volatile(gpio_enable_w1tc, 1 << 4);  // Disable GPIO4 output

                // Route SPI3_Q_IN (signal 67) from GPIO4
                let spiq_in_sel = 0x60004154 + (67 * 4);  // Signal 67 = SPI3_Q_IN
                core::ptr::write_volatile(spiq_in_sel as *mut u32, (1 << 7) | 4);  // sig_in_sel=1, gpio=4
                info!("  GPIO4 (MISO): disabled output, routed SPI3_Q_IN (sig 67) from GPIO4");

                // 2. Fix GPIO5 (SCK) - route SPI3_CLK_OUT (signal 66) to it
                let gpio5_func_out = 0x60004554 + (5 * 4);
                let current_gpio5 = core::ptr::read_volatile(gpio5_func_out as *const u32);
                core::ptr::write_volatile(gpio5_func_out as *mut u32, 66);  // SPI3_CLK_OUT
                info!("  GPIO5 (SCK): FUNC_OUT was 0x{:02X}, set to 66 (SPI3_CLK_OUT)", current_gpio5 & 0x1FF);

                // 3. Fix GPIO6 (MOSI) - route SPI3_D_OUT (signal 68) to it
                let gpio6_func_out = 0x60004554 + (6 * 4);
                let current_gpio6 = core::ptr::read_volatile(gpio6_func_out as *const u32);
                core::ptr::write_volatile(gpio6_func_out as *mut u32, 68);  // SPI3_D_OUT
                info!("  GPIO6 (MOSI): FUNC_OUT was 0x{:02X}, set to 68 (SPI3_D_OUT)", current_gpio6 & 0x1FF);

                // 4. GPIO8 (NSS) - keep as GPIO output (we control it manually)
                let gpio8_func_out = 0x60004554 + (8 * 4);
                let current_gpio8 = core::ptr::read_volatile(gpio8_func_out as *const u32);
                info!("  GPIO8 (NSS): FUNC_OUT is 0x{:02X} (GPIO mode)", current_gpio8 & 0x1FF);

                // 5. Make sure GPIO4 has pull-up enabled
                // GPIO4 IO_MUX is at offset 0x14 from base 0x60009000
                let io_mux_gpio4 = 0x60009014 as *mut u32;
                let mux_val = core::ptr::read_volatile(io_mux_gpio4);
                let new_mux = (mux_val & !(0x7 << 12)) | (1 << 12) | (1 << 8);  // MCU_SEL=1 (GPIO), pull-up
                core::ptr::write_volatile(io_mux_gpio4, new_mux);

                // Verify final state
                let gpio_enable_final = core::ptr::read_volatile(0x60004020 as *const u32);
                let gpio5_final = core::ptr::read_volatile(gpio5_func_out as *const u32);
                let gpio6_final = core::ptr::read_volatile(gpio6_func_out as *const u32);
                info!("  Final FUNC_OUT: GPIO5=0x{:02X} GPIO6=0x{:02X}",
                    gpio5_final & 0x1FF, gpio6_final & 0x1FF);
                info!("  Final GPIO_ENABLE: 0x{:08X}", gpio_enable_final);
                info!("    GPIO5={} GPIO4={} GPIO6={}",
                    (gpio_enable_final >> 5) & 1,
                    (gpio_enable_final >> 4) & 1,
                    (gpio_enable_final >> 6) & 1);

                // Verify SPI3 peripheral clock is now enabled
                let clk_after = core::ptr::read_volatile(0x60026010 as *const u32);
                let spi3_clk_en = (clk_after >> 23) & 1;
                info!("  PERIP_CLK_EN1 after fix: 0x{:08X} (SPI3_CLK={})", clk_after, spi3_clk_en);

                // Check SPI3 registers after GPIO routing
                let spi3_base = 0x60025000;  // SPI3 (not SPI2 which is 0x60024000)
                let spi_clk = core::ptr::read_volatile((spi3_base + 0x0C) as *const u32);
                let spi_user = core::ptr::read_volatile((spi3_base + 0x10) as *const u32);
                let spi_ctrl = core::ptr::read_volatile((spi3_base + 0x08) as *const u32);
                let spi_cmd = core::ptr::read_volatile((spi3_base + 0x00) as *const u32);
                info!("  SPI3 after GPIO routing: CMD=0x{:08X} CTRL=0x{:08X} CLOCK=0x{:08X} USER=0x{:08X}",
                    spi_cmd, spi_ctrl, spi_clk, spi_user);

                // FIX: SPI clock might be too fast (bit 31 = CLK_EQU_SYSCLK means 80MHz!)
                // Force proper clock dividers for 1 MHz: APB=80MHz / 80 = 1MHz
                // CLKCNT_L = 79, CLKCNT_H = 39, CLKCNT_N = 79, CLKDIV_PRE = 0
                // Clear bit 31 to use dividers instead of APB clock directly
                if (spi_clk >> 31) & 1 == 1 {
                    info!("  !!! SPI clock too fast (CLK_EQU_SYSCLK=1), fixing to 1 MHz !!!");
                    let clk_val: u32 = (79 << 0)   // CLKCNT_L
                                     | (39 << 6)   // CLKCNT_H
                                     | (79 << 12)  // CLKCNT_N
                                     | (0 << 18);  // CLKDIV_PRE (no bit 31!)
                    core::ptr::write_volatile((spi3_base + 0x0C) as *mut u32, clk_val);
                    let clk_after = core::ptr::read_volatile((spi3_base + 0x0C) as *const u32);
                    info!("  SPI3_CLOCK fixed: 0x{:08X} -> 0x{:08X}", spi_clk, clk_after);
                }

                // Increase GPIO drive strength for SCK (GPIO5) and MOSI (GPIO6)
                // IO_MUX drive strength is bits [11:10]: 0=5mA, 1=10mA, 2=20mA, 3=40mA
                // GPIO5 IO_MUX is at offset 0x18, GPIO6 is at offset 0x1C
                let io_mux_gpio5 = 0x60009018 as *mut u32;
                let io_mux_gpio6 = 0x6000901C as *mut u32;
                let mux5 = core::ptr::read_volatile(io_mux_gpio5);
                let mux6 = core::ptr::read_volatile(io_mux_gpio6);
                // Set drive strength to maximum (3 = 40mA)
                let new_mux5 = (mux5 & !(0x3 << 10)) | (3 << 10);  // FUN_DRV is bits [11:10]
                let new_mux6 = (mux6 & !(0x3 << 10)) | (3 << 10);
                core::ptr::write_volatile(io_mux_gpio5, new_mux5);
                core::ptr::write_volatile(io_mux_gpio6, new_mux6);
                info!("  GPIO5 drive: 0x{:08X} -> 0x{:08X}", mux5, new_mux5);
                info!("  GPIO6 drive: 0x{:08X} -> 0x{:08X}", mux6, new_mux6);
            }
            info!("=== SPI3 FIX DONE ===");

            Some(driver)
        }
        Err(e) => {
            warn!("SPI3 init failed: {:?}", e);
            None
        }
    };

    // Initialize NFC if SPI is ready
    if let Some(spi_bus) = spi_driver {
        // Leak SPI driver to get 'static lifetime
        let spi_static: &'static mut SpiDriver<'static> = Box::leak(Box::new(spi_bus));

        // Create SPI device (CS is manually controlled via GPIO8)
        // PN5180 uses SPI Mode 0: CPOL=0 (idle low), CPHA=0 (sample on rising edge)
        use esp_idf_hal::spi::config::{Mode, Phase, Polarity};
        // Try faster SPI speed - slow speeds allow more capacitive coupling
        let spi_config = SpiConfig::default()
            .baudrate(Hertz(1_000_000)) // 1 MHz - faster to reduce coupling
            .data_mode(Mode {
                polarity: Polarity::IdleLow,
                phase: Phase::CaptureOnFirstTransition,
            });
        info!("SPI Mode 0 configured (CPOL=0, CPHA=0) at 1 MHz");
        match SpiDeviceDriver::new(spi_static, Option::<esp_idf_hal::gpio::AnyOutputPin>::None, &spi_config) {
            Ok(spi_device) => {
                // Initialize GPIO pins for NFC
                // NSS: GPIO8 (J11 Pin 6)
                // BUSY: Not used (working config from c27f680)
                // RST: Not used (GPIO15 conflicts with touch I2C)
                let nss_result = PinDriver::output(peripherals.pins.gpio8);

                match nss_result {
                    Ok(nss) => {
                        let mut nfc_state = nfc::pn5180::Pn5180State::new();

                        // Create driver manually to run diagnostics before full init
                        info!("=== PN5180 PRE-INIT DIAGNOSTICS ===");

                        // Set NSS high initially (inactive)
                        let mut nss = nss;
                        let _ = nss.set_high();
                        FreeRtos::delay_ms(100);  // Wait for PN5180 power-on

                        // Create a temporary driver just for diagnostics
                        let mut diag_driver = nfc::pn5180::Pn5180Driver {
                            spi: spi_device,
                            nss,
                            busy: None,
                            rst: None,
                        };

                        // Run comprehensive SPI diagnostics
                        match diag_driver.spi_diagnostic_test() {
                            Ok(_) => info!("SPI diagnostics completed"),
                            Err(e) => warn!("SPI diagnostics error: {:?}", e),
                        }

                        // Try to init properly after diagnostics
                        let (spi_device, nss) = (diag_driver.spi, diag_driver.nss);
                        match nfc::pn5180::init_pn5180(spi_device, nss, None, None, &mut nfc_state) {
                            Ok(driver) => {
                                info!("PN5180 NFC initialized successfully");
                                // Store driver for later use in main loop
                                // TODO: Add NFC manager to handle tag detection
                                drop(driver);  // For now, just verify init works
                            }
                            Err(e) => warn!("PN5180 init failed: {:?}", e),
                        }
                    }
                    Err(e) => warn!("Failed to initialize NFC NSS pin (GPIO8): {:?}", e),
                }
            }
            Err(e) => warn!("SPI device creation failed: {:?}", e),
        }
    }
    } // end if NFC_ENABLED

    info!("Entering main loop...");

    // Main loop counter for periodic tasks
    let mut loop_count: u32 = 0;

    // Main loop
    loop {
        unsafe {
            display_tick();
        }

        // Poll scale every 10 iterations (~50ms at 5ms delay)
        loop_count = loop_count.wrapping_add(1);
        if loop_count % 10 == 0 {
            scale_manager::poll_scale();
        }

        // Post-WiFi initialization - check frequently until WiFi connects
        static WIFI_INIT_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        static OTA_CHECK_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !WIFI_INIT_DONE.load(std::sync::atomic::Ordering::Relaxed) {
            if loop_count % 20 == 0 && wifi_manager::is_connected() {
                // Initialize SNTP for time sync (may take time)
                time_manager::init_sntp();
                // Set backend server URL
                backend_client::set_server_url("http://192.168.255.16:3000");
                // Sync time immediately from backend (faster than SNTP)
                backend_client::sync_time();
                WIFI_INIT_DONE.store(true, std::sync::atomic::Ordering::Relaxed);
                info!("Post-WiFi init complete (SNTP + backend URL + time sync)");
                // Immediate first poll for printer data
                backend_client::poll_backend();
            }
        } else if loop_count % 400 == 0 {
            // Regular polling every 2 seconds
            backend_client::poll_backend();
        }

        // OTA check on startup (once, after WiFi init) - check but don't auto-install
        // Updates are triggered via backend command
        if WIFI_INIT_DONE.load(std::sync::atomic::Ordering::Relaxed)
            && !OTA_CHECK_DONE.load(std::sync::atomic::Ordering::Relaxed)
        {
            OTA_CHECK_DONE.store(true, std::sync::atomic::Ordering::Relaxed);
            info!("Firmware version: v{}", ota_manager::get_version());

            // Check for updates and store result (don't auto-install)
            match ota_manager::check_for_update("http://192.168.255.16:3000") {
                Ok(info) => {
                    if info.available {
                        info!("Firmware update available: v{}", info.version);
                        ota_manager::set_update_available(true, &info.version);
                    } else {
                        info!("Firmware is up to date");
                        ota_manager::set_update_available(false, "");
                    }
                }
                Err(e) => {
                    warn!("OTA check failed: {}", e);
                }
            }
        }

        // Poll NFC bridge every 100 iterations (~500ms at 5ms delay)
        if loop_count % 100 == 0 {
            nfc_bridge_manager::poll_nfc();
        }

        FreeRtos::delay_ms(5);
    }
}
