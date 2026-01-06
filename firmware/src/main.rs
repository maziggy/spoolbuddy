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

// NFC module for PN5180 (hardware integration)
mod nfc;

// NFC manager with C-callable interface (disabled until pin conflict resolved)
// mod nfc_manager;

// WiFi manager with C-callable interface
mod wifi_manager;

// Backend client for server communication
mod backend_client;

// Time manager for NTP sync
mod time_manager;

// OTA update manager
mod ota_manager;

// NFC disabled until cable arrives
const NFC_ENABLED: bool = false;

// Display driver C functions (handles LVGL init and EEZ UI)
extern "C" {
    fn display_init() -> i32;
    fn display_tick();
}

fn main() {
    // Initialize ESP-IDF
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    info!("SpoolBuddy Firmware starting...");

    let peripherals = Peripherals::take().unwrap();

    // Initialize WiFi subsystem (must be done before display init uses I2C0)
    let sysloop = EspSystemEventLoop::take().expect("Failed to take system event loop");
    let nvs = EspDefaultNvsPartition::take().ok();

    match wifi_manager::init_wifi_system(peripherals.modem, sysloop, nvs) {
        Ok(_) => info!("WiFi subsystem ready"),
        Err(e) => warn!("WiFi init failed: {}", e),
    }

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

    // Initialize Scale I2C bus on UART1-OUT port
    // UART1-OUT pinout: IO19-RX1, IO20-TX1, 3V3, GND
    // Using: GPIO19=SDA, GPIO20=SCL
    info!("=== SCALE I2C INIT (UART1-OUT: GPIO19/20) ===");
    let i2c1_config = I2cConfig::new().baudrate(Hertz(100_000));
    let mut scale_i2c = match I2cDriver::new(
        peripherals.i2c1,
        peripherals.pins.gpio19,  // SDA (UART1-OUT IO19-RX1)
        peripherals.pins.gpio20,  // SCL (UART1-OUT IO20-TX1)
        &i2c1_config,
    ) {
        Ok(driver) => {
            info!("Scale I2C1 initialized (SDA=GPIO19, SCL=GPIO20 on UART1-OUT)");
            Some(driver)
        }
        Err(e) => {
            warn!("Scale I2C1 init failed: {:?}", e);
            None
        }
    };

    // Scan I2C1 for devices
    if let Some(ref mut i2c) = scale_i2c {
        info!("Scanning I2C1 bus for scale...");
        let mut found_nau7802 = false;
        for addr in 0x08..0x78 {
            let mut buf = [0u8; 1];
            if i2c.read(addr, &mut buf, 100).is_ok() {
                info!("  Found I2C device at 0x{:02X}", addr);
                if addr == scale::nau7802::NAU7802_ADDR {
                    info!("  -> NAU7802 scale chip detected!");
                    found_nau7802 = true;
                }
            }
        }
        if !found_nau7802 {
            warn!("  NAU7802 not found at 0x{:02X}", scale::nau7802::NAU7802_ADDR);
        }
    }
    info!("=== SCALE I2C DONE ===");

    // Initialize scale driver and manager if I2C is ready
    if let Some(i2c) = scale_i2c {
        let mut scale_state = scale::nau7802::Nau7802State::new();

        // Leak the I2C driver to get 'static lifetime for the manager
        let i2c_static: &'static mut I2cDriver<'static> = Box::leak(Box::new(i2c));

        match scale::nau7802::init(i2c_static, &mut scale_state) {
            Ok(()) => {
                info!("NAU7802 scale initialized");
                // Transfer ownership to scale manager
                // We need to take ownership back from the leaked box
                let i2c_owned = unsafe { Box::from_raw(i2c_static as *mut I2cDriver<'static>) };
                scale_manager::init_scale_manager(*i2c_owned, scale_state);
            }
            Err(e) => warn!("NAU7802 init failed: {:?}", e),
        }
    }

    // ==========================================================================
    // Initialize PN5180 NFC Module
    // ==========================================================================
    if NFC_ENABLED {
    // NOTE: J9 header pins (IO4/5/6) are used internally by the RGB LCD display!
    // We use UART0-OUT header and J11 for SPI instead:
    //   - IO43 (UART0-OUT) -> SCK
    //   - IO44 (UART0-OUT) -> MISO
    //   - IO16 (J11 Pin 2) -> MOSI
    // Control pins on J11 header:
    //   - IO8  (J11 Pin 6) -> NSS (chip select)
    //   - IO2  (J11 Pin 5) -> BUSY
    //   - IO15 (J11 Pin 3) -> RST
    info!("=== NFC SPI INIT ===");
    info!("Using pins: SCK=GPIO43, MISO=GPIO44, MOSI=GPIO16, NSS=GPIO8");

    // Quick GPIO sanity check for new pins
    info!("=== GPIO SANITY CHECK ===");
    {
        use esp_idf_hal::gpio::Pull;

        // Test GPIO44 (MISO) - should float high with pull-up
        let gpio44_test = PinDriver::input(peripherals.pins.gpio44, Pull::Up).unwrap();
        FreeRtos::delay_ms(5);
        let miso_state = gpio44_test.is_high();
        info!("  GPIO44 (MISO) with pull-up: {}", if miso_state { "HIGH (good)" } else { "LOW (check wiring!)" });
        drop(gpio44_test);

        // Test GPIO43 (SCK) and GPIO16 (MOSI) as outputs
        let mut gpio43_test = PinDriver::output(peripherals.pins.gpio43).unwrap();
        let mut gpio16_test = PinDriver::output(peripherals.pins.gpio16).unwrap();

        gpio43_test.set_high().unwrap();
        gpio16_test.set_high().unwrap();
        FreeRtos::delay_ms(1);
        info!("  GPIO43 (SCK) and GPIO16 (MOSI) configured as outputs");

        gpio43_test.set_low().unwrap();
        gpio16_test.set_low().unwrap();
        drop(gpio43_test);
        drop(gpio16_test);
    }
    info!("=== GPIO SANITY CHECK DONE ===");

    // ==========================================================================
    // BIT-BANG SPI TEST - Tests physical wiring before SPI peripheral init
    // ==========================================================================
    // This test manually toggles GPIO pins to verify physical connections
    // to the PN5180, bypassing the ESP32's SPI peripheral entirely.
    // Using new pins: SCK=GPIO43, MISO=GPIO44, MOSI=GPIO16, NSS=GPIO8
    info!("=== BIT-BANG SPI TEST ===");
    info!("This test manually toggles GPIOs to verify physical wiring.");
    info!("Pins: SCK=GPIO43, MISO=GPIO44, MOSI=GPIO16, NSS=GPIO8");
    {
        use esp_idf_hal::gpio::Pull;

        // Steal the pins for bit-bang test
        let gpio43_bb = unsafe { esp_idf_hal::gpio::Gpio43::steal() };
        let gpio44_bb = unsafe { esp_idf_hal::gpio::Gpio44::steal() };
        let gpio16_bb = unsafe { esp_idf_hal::gpio::Gpio16::steal() };
        let gpio8_bb = unsafe { esp_idf_hal::gpio::Gpio8::steal() };

        // Configure pins:
        // - GPIO43 (SCK) = output
        // - GPIO16 (MOSI) = output
        // - GPIO44 (MISO) = input with pull-up
        // - GPIO8 (NSS) = output
        let mut sck = PinDriver::output(gpio43_bb).unwrap();
        let mut mosi = PinDriver::output(gpio16_bb).unwrap();
        let miso = PinDriver::input(gpio44_bb, Pull::Up).unwrap();
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
        info!("  Testing if GPIO43 (SCK) and GPIO16 (MOSI) can actually drive output...");

        // GPIO43 is in GPIO_OUT1 (bits 32-53), GPIO16 is in GPIO_OUT (bits 0-31)
        // GPIO_OUT1_REG = 0x60004010, GPIO_IN1_REG = 0x60004040
        let gpio_out1_before: u32;
        let gpio_out_before: u32;
        unsafe {
            gpio_out1_before = core::ptr::read_volatile(0x60004010 as *const u32);  // GPIO32-53
            gpio_out_before = core::ptr::read_volatile(0x60004004 as *const u32);   // GPIO0-31
        }
        info!("  GPIO_OUT1 before: SCK(43)={}", (gpio_out1_before >> (43 - 32)) & 1);
        info!("  GPIO_OUT  before: MOSI(16)={}", (gpio_out_before >> 16) & 1);

        // Set both HIGH
        sck.set_high().unwrap();
        mosi.set_high().unwrap();
        FreeRtos::delay_ms(1);
        let gpio_out1_high: u32;
        let gpio_out_high: u32;
        let gpio_in1_high: u32;
        let gpio_in_high: u32;
        unsafe {
            gpio_out1_high = core::ptr::read_volatile(0x60004010 as *const u32);
            gpio_out_high = core::ptr::read_volatile(0x60004004 as *const u32);
            gpio_in1_high = core::ptr::read_volatile(0x60004040 as *const u32);
            gpio_in_high = core::ptr::read_volatile(0x6000403C as *const u32);
        }
        info!("  Set HIGH: SCK_OUT={} SCK_IN={}, MOSI_OUT={} MOSI_IN={}",
            (gpio_out1_high >> (43 - 32)) & 1, (gpio_in1_high >> (43 - 32)) & 1,
            (gpio_out_high >> 16) & 1, (gpio_in_high >> 16) & 1);

        // Set both LOW
        sck.set_low().unwrap();
        mosi.set_low().unwrap();
        FreeRtos::delay_ms(1);
        let gpio_out1_low: u32;
        let gpio_out_low: u32;
        let gpio_in1_low: u32;
        let gpio_in_low: u32;
        unsafe {
            gpio_out1_low = core::ptr::read_volatile(0x60004010 as *const u32);
            gpio_out_low = core::ptr::read_volatile(0x60004004 as *const u32);
            gpio_in1_low = core::ptr::read_volatile(0x60004040 as *const u32);
            gpio_in_low = core::ptr::read_volatile(0x6000403C as *const u32);
        }
        info!("  Set LOW:  SCK_OUT={} SCK_IN={}, MOSI_OUT={} MOSI_IN={}",
            (gpio_out1_low >> (43 - 32)) & 1, (gpio_in1_low >> (43 - 32)) & 1,
            (gpio_out_low >> 16) & 1, (gpio_in_low >> 16) & 1);

        // Check if GPIO_OUT actually changed
        let sck_out_works = ((gpio_out1_high >> (43 - 32)) & 1) != ((gpio_out1_low >> (43 - 32)) & 1);
        let mosi_out_works = ((gpio_out_high >> 16) & 1) != ((gpio_out_low >> 16) & 1);
        let sck_in_works = ((gpio_in1_high >> (43 - 32)) & 1) != ((gpio_in1_low >> (43 - 32)) & 1);
        let mosi_in_works = ((gpio_in_high >> 16) & 1) != ((gpio_in_low >> 16) & 1);

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
            info!("  Check GPIO43 wiring on UART0-OUT header.");
        }

        if mosi_out_works && !mosi_in_works {
            info!("");
            info!("  *** MOSI: GPIO_OUT changes but GPIO_IN doesn't! ***");
            info!("  Check GPIO16 wiring on J11 header.");
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
            info!("  *** SCK -> MISO LOOPBACK WORKS! GPIO43 is functional! ***");
        } else {
            info!("  SCK loopback failed - wire not connected or GPIO43 issue");
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
            info!("  *** MOSI -> MISO LOOPBACK WORKS! GPIO16 is functional! ***");
        } else {
            info!("  MOSI loopback failed - wire not connected or GPIO16 issue");
        }

        // Summary
        info!("");
        info!("=== LOOPBACK TEST SUMMARY ===");
        if mosi_loopback_works && !sck_loopback_works {
            info!("MOSI works but SCK doesn't - check GPIO43 on UART0-OUT header!");
        } else if sck_loopback_works && !mosi_loopback_works {
            info!("SCK works but MOSI doesn't - check GPIO16 on J11 header!");
        } else if sck_loopback_works && mosi_loopback_works {
            info!("Both SCK and MOSI loopbacks work - GPIO pins are functional!");
            info!("If PN5180 still doesn't respond, check:");
            info!("  - NSS (GPIO8) connection to PN5180");
            info!("  - VCC/GND power to PN5180");
            info!("  - PN5180 module itself");
        } else {
            info!("Neither loopback worked - check wire connections:");
            info!("  SCK  = GPIO43 on UART0-OUT header");
            info!("  MOSI = GPIO16 on J11 Pin 2");
            info!("  MISO = GPIO44 on UART0-OUT header");
        }

        // Release pins so they can be used by SPI
        drop(sck);
        drop(mosi);
        drop(miso);
        drop(nss);
    }
    info!("=== BIT-BANG TEST DONE ===");

    // Re-take the pins for SPI (they were consumed by the GPIO test)
    let gpio43 = unsafe { esp_idf_hal::gpio::Gpio43::steal() };  // SCK
    let gpio44 = unsafe { esp_idf_hal::gpio::Gpio44::steal() };  // MISO
    let gpio16 = unsafe { esp_idf_hal::gpio::Gpio16::steal() };  // MOSI

    // Enable internal pull-up on MISO (GPIO44) to prevent floating
    info!("Enabling internal pull-up on MISO (GPIO44) via IO_MUX...");
    unsafe {
        // ESP32-S3 IO_MUX register addresses: Base: 0x60009000
        // Each GPIO has a 4-byte register, but they're NOT sequential!
        // GPIO44 IO_MUX is at offset 0xB4 (from TRM)
        let io_mux_gpio44 = 0x60009000 + 0xB4;
        let current = core::ptr::read_volatile(io_mux_gpio44 as *const u32);
        // Bit 8 = FUN_WPU (pull-up), Bit 7 = FUN_WPD (pull-down)
        let new_val = (current | (1 << 8)) & !(1 << 7);  // Enable pull-up, disable pull-down
        core::ptr::write_volatile(io_mux_gpio44 as *mut u32, new_val);
        info!("  GPIO44 IO_MUX @ 0x{:08X}: 0x{:08X} -> 0x{:08X}", io_mux_gpio44, current, new_val);

        // Check GPIO_ENABLE1_REG to see if something is driving GPIO44 as output
        let gpio_enable1 = 0x60004024 as *const u32;  // GPIO_ENABLE1_REG (GPIO32-53)
        let gpio_enable1_val = core::ptr::read_volatile(gpio_enable1);
        let gpio44_is_output = (gpio_enable1_val >> (44 - 32)) & 1;
        info!("  GPIO_ENABLE1_REG: 0x{:08X} (GPIO44 output={})", gpio_enable1_val, gpio44_is_output);

        // Check GPIO_IN1_REG to see the actual pin state
        let gpio_in1 = 0x60004040 as *const u32;  // GPIO_IN1_REG (GPIO32-53)
        let gpio_in1_val = core::ptr::read_volatile(gpio_in1);
        let gpio44_level = (gpio_in1_val >> (44 - 32)) & 1;
        info!("  GPIO_IN1_REG: 0x{:08X} (GPIO44 level={})", gpio_in1_val, gpio44_level);
    }

    // Initialize SPI bus using SPI3 with new pins
    let spi_driver = match SpiDriver::new(
        peripherals.spi3,
        gpio43,  // SCK
        gpio16,  // MOSI
        Some(gpio44),  // MISO
        &SpiDriverConfig::default(),
    ) {
        Ok(driver) => {
            info!("SPI3 bus initialized (SCK=GPIO43, MOSI=GPIO16, MISO=GPIO44)");

            // Check GPIO state AFTER SPI initialization
            info!("=== GPIO STATE AFTER SPI INIT ===");
            unsafe {
                // Check SPI pins: GPIO43=SCK, GPIO44=MISO, GPIO16=MOSI, GPIO8=NSS

                // GPIO_ENABLE (0-31) and GPIO_ENABLE1 (32-53) - which pins are outputs
                let gpio_enable_val = core::ptr::read_volatile(0x60004020 as *const u32);
                let gpio_enable1_val = core::ptr::read_volatile(0x60004024 as *const u32);
                info!("  GPIO_ENABLE: 0x{:08X}, GPIO_ENABLE1: 0x{:08X}", gpio_enable_val, gpio_enable1_val);
                info!("    GPIO43(SCK)={} GPIO44(MISO)={} GPIO16(MOSI)={} GPIO8(NSS)={}",
                    (gpio_enable1_val >> (43 - 32)) & 1,
                    (gpio_enable1_val >> (44 - 32)) & 1,
                    (gpio_enable_val >> 16) & 1,
                    (gpio_enable_val >> 8) & 1);

                // GPIO_OUT - what values are being driven
                let gpio_out_val = core::ptr::read_volatile(0x60004004 as *const u32);
                let gpio_out1_val = core::ptr::read_volatile(0x60004010 as *const u32);
                info!("  GPIO_OUT: 0x{:08X}, GPIO_OUT1: 0x{:08X}", gpio_out_val, gpio_out1_val);

                // Check FUNC_OUT_SEL for each pin (which peripheral signal is routed)
                let gpio43_out = core::ptr::read_volatile((0x60004554 + 43*4) as *const u32);
                let gpio44_out = core::ptr::read_volatile((0x60004554 + 44*4) as *const u32);
                let gpio16_out = core::ptr::read_volatile((0x60004554 + 16*4) as *const u32);
                let gpio8_out = core::ptr::read_volatile((0x60004554 + 8*4) as *const u32);
                info!("  FUNC_OUT_SEL: GPIO43=0x{:02X} GPIO44=0x{:02X} GPIO16=0x{:02X} GPIO8=0x{:02X}",
                    gpio43_out & 0x1FF, gpio44_out & 0x1FF, gpio16_out & 0x1FF, gpio8_out & 0x1FF);
                info!("    Expected: GPIO43=SPI3_CLK(66) GPIO16=SPI3_D(68) GPIO44=input");

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
                let gpio_in1_val = core::ptr::read_volatile(0x60004040 as *const u32);
                info!("  GPIO_IN: 0x{:08X}, GPIO_IN1: 0x{:08X}", gpio_in_val, gpio_in1_val);
                info!("    GPIO43={} GPIO44={} GPIO16={} GPIO8={}",
                    (gpio_in1_val >> (43 - 32)) & 1,
                    (gpio_in1_val >> (44 - 32)) & 1,
                    (gpio_in_val >> 16) & 1,
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
                // https://github.com/espressif/esp-idf/blob/master/components/soc/esp32s3/include/soc/gpio_sig_map.h
                // SPI3_CLK_OUT_IDX = 66 (SCK output)
                // SPI3_Q_IN_IDX = 67 (MISO input)
                // SPI3_D_OUT_IDX = 68 (MOSI output)
                //
                // New pin assignments:
                // GPIO43 = SCK, GPIO44 = MISO, GPIO16 = MOSI

                // 1. Fix GPIO44 (MISO) - make it input, route to SPI3_Q_IN (signal 67)
                // GPIO44 is in GPIO_ENABLE1 (bits 32-53), bit 12 (44-32=12)
                let gpio_enable1_w1tc = 0x6000402C as *mut u32;  // GPIO_ENABLE1_W1TC
                core::ptr::write_volatile(gpio_enable1_w1tc, 1 << (44 - 32));  // Disable GPIO44 output

                // Route SPI3_Q_IN (signal 67) from GPIO44
                let spiq_in_sel = 0x60004154 + (67 * 4);  // Signal 67 = SPI3_Q_IN
                core::ptr::write_volatile(spiq_in_sel as *mut u32, (1 << 7) | 44);  // sig_in_sel=1, gpio=44
                info!("  GPIO44 (MISO): disabled output, routed SPI3_Q_IN (sig 67) from GPIO44");

                // 2. Fix GPIO43 (SCK) - route SPI3_CLK_OUT (signal 66) to it
                let gpio43_func_out = 0x60004554 + (43 * 4);
                let current_gpio43 = core::ptr::read_volatile(gpio43_func_out as *const u32);
                core::ptr::write_volatile(gpio43_func_out as *mut u32, 66);  // SPI3_CLK_OUT
                info!("  GPIO43 (SCK): FUNC_OUT was 0x{:02X}, set to 66 (SPI3_CLK_OUT)", current_gpio43 & 0x1FF);

                // 3. Fix GPIO16 (MOSI) - route SPI3_D_OUT (signal 68) to it
                let gpio16_func_out = 0x60004554 + (16 * 4);
                let current_gpio16 = core::ptr::read_volatile(gpio16_func_out as *const u32);
                core::ptr::write_volatile(gpio16_func_out as *mut u32, 68);  // SPI3_D_OUT
                info!("  GPIO16 (MOSI): FUNC_OUT was 0x{:02X}, set to 68 (SPI3_D_OUT)", current_gpio16 & 0x1FF);

                // 4. GPIO8 (NSS) - keep as GPIO output (we control it manually)
                let gpio8_func_out = 0x60004554 + (8 * 4);
                let current_gpio8 = core::ptr::read_volatile(gpio8_func_out as *const u32);
                info!("  GPIO8 (NSS): FUNC_OUT is 0x{:02X} (GPIO mode)", current_gpio8 & 0x1FF);

                // 5. Make sure GPIO44 has pull-up enabled
                // GPIO44 IO_MUX is at offset 0xB4 from base 0x60009000
                let io_mux_gpio44 = 0x600090B4 as *mut u32;
                let mux_val = core::ptr::read_volatile(io_mux_gpio44);
                let new_mux = (mux_val & !(0x7 << 12)) | (1 << 12) | (1 << 8);  // MCU_SEL=1 (GPIO), pull-up
                core::ptr::write_volatile(io_mux_gpio44, new_mux);

                // Verify final state
                let gpio_enable_final = core::ptr::read_volatile(0x60004020 as *const u32);
                let gpio_enable1_final = core::ptr::read_volatile(0x60004024 as *const u32);
                let gpio43_final = core::ptr::read_volatile(gpio43_func_out as *const u32);
                let gpio16_final = core::ptr::read_volatile(gpio16_func_out as *const u32);
                info!("  Final FUNC_OUT: GPIO43=0x{:02X} GPIO16=0x{:02X}",
                    gpio43_final & 0x1FF, gpio16_final & 0x1FF);
                info!("  Final GPIO_ENABLE: 0x{:08X} GPIO_ENABLE1: 0x{:08X}",
                    gpio_enable_final, gpio_enable1_final);
                info!("    GPIO43={} GPIO44={} GPIO16={}",
                    (gpio_enable1_final >> (43 - 32)) & 1,
                    (gpio_enable1_final >> (44 - 32)) & 1,
                    (gpio_enable_final >> 16) & 1);

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

                // Increase GPIO drive strength for SCK (GPIO43) and MOSI (GPIO16)
                // IO_MUX drive strength is bits [9:8]: 0=5mA, 1=10mA, 2=20mA, 3=40mA
                // GPIO43 IO_MUX is at offset 0xB0, GPIO16 is at offset 0x44
                let io_mux_gpio43 = 0x600090B0 as *mut u32;
                let io_mux_gpio16 = 0x60009044 as *mut u32;
                let mux43 = core::ptr::read_volatile(io_mux_gpio43);
                let mux16 = core::ptr::read_volatile(io_mux_gpio16);
                // Set drive strength to maximum (3 = 40mA)
                let new_mux43 = (mux43 & !(0x3 << 10)) | (3 << 10);  // FUN_DRV is bits [11:10]
                let new_mux16 = (mux16 & !(0x3 << 10)) | (3 << 10);
                core::ptr::write_volatile(io_mux_gpio43, new_mux43);
                core::ptr::write_volatile(io_mux_gpio16, new_mux16);
                info!("  GPIO43 drive: 0x{:08X} -> 0x{:08X}", mux43, new_mux43);
                info!("  GPIO16 drive: 0x{:08X} -> 0x{:08X}", mux16, new_mux16);
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
                // BUSY: Not used (GPIO44 doesn't work properly)
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

        // OTA check on startup (once, after WiFi init) - just log, don't auto-update
        // Updates are triggered via backend command (reboot with update flag)
        if WIFI_INIT_DONE.load(std::sync::atomic::Ordering::Relaxed)
            && !OTA_CHECK_DONE.load(std::sync::atomic::Ordering::Relaxed)
        {
            OTA_CHECK_DONE.store(true, std::sync::atomic::Ordering::Relaxed);
            info!("Firmware version: v{}", ota_manager::get_version());
        }

        // Poll NFC every 20 iterations (~100ms at 5ms delay)
        // Disabled until pin conflict with Touch I2C (GPIO15) is resolved
        // #[cfg(feature = "nfc_enabled")]
        // if loop_count % 20 == 0 {
        //     nfc_manager::poll_nfc();
        // }

        FreeRtos::delay_ms(5);
    }
}
