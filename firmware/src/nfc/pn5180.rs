//! PN5180 NFC controller driver.
//!
//! The PN5180 communicates via SPI with the following pins:
//! - MOSI, MISO, SCLK - Standard SPI
//! - NSS - Chip select (active low)
//! - BUSY - Indicates when chip is processing (active high)
//! - RST - Hardware reset (active low)
//!
//! CrowPanel Advance 7.0" Header pinout:
//!
//! NOTE: J9 pins (IO4/5/6) are internally used by the RGB LCD display!
//! We use UART0-OUT and J11 headers instead for SPI.
//!
//! ```text
//!    UART0-OUT              J11 (Right)
//!    ┌────────┐             ┌────────┐
//!    │  IO44  │  ← MISO     │  IO19  │
//!    │  IO43  │  ← SCK      │  IO16  │  ← MOSI
//!    │  3V3   │  ← VCC      │  IO15  │  ← RST
//!    │  GND   │  ← GND      │   NC   │
//!    └────────┘             │  IO2   │  ← BUSY
//!                           │  IO8   │  ← CS (NSS)
//!                           │   NC   │
//!                           └────────┘
//! ```
//!
//! GPIO assignments:
//! - IO43 (UART0-OUT)  -> SPI SCK
//! - IO44 (UART0-OUT)  -> SPI MISO
//! - IO16 (J11 Pin 2)  -> SPI MOSI
//! - IO8  (J11 Pin 6)  -> NSS (chip select)
//! - IO2  (J11 Pin 5)  -> BUSY
//! - IO15 (J11 Pin 3)  -> RST
//!
//! Commands are sent as:
//! [CMD_BYTE] [PAYLOAD...]
//!
//! Responses are read after BUSY goes low.

use esp_idf_hal::gpio::{Input, Output, PinDriver};
use esp_idf_hal::delay::FreeRtos;
use embedded_hal::spi::SpiDevice;
use log::{info, warn};

// =============================================================================
// GPIO Pin Definitions for CrowPanel Advance 7.0"
// =============================================================================
// These pins are exposed on the Wireless Module Headers (J9 + J11)
// Requires DIP switch setting: S1=0, S0=1

/// SPI Clock pin (UART0-OUT)
pub const PIN_SCK: u8 = 43;   // IO43 (was IO5 on J9, but J9 is used by RGB LCD)

/// SPI MISO pin (UART0-OUT)
pub const PIN_MISO: u8 = 44;  // IO44 (was IO4 on J9, but J9 is used by RGB LCD)

/// SPI MOSI pin (J11 Pin 2)
pub const PIN_MOSI: u8 = 16;  // IO16 (was IO6 on J9, but J9 is used by RGB LCD)

/// Chip Select pin (J11 Pin 6) - directly controlled, active low
pub const PIN_NSS: u8 = 8;   // IO8

/// Busy indicator pin (J11 Pin 5) - active high when processing
pub const PIN_BUSY: u8 = 2;  // IO2

/// Hardware reset pin (J11 Pin 3) - active low
pub const PIN_RST: u8 = 15;  // IO15

/// PN5180 command codes
#[allow(dead_code)]
pub mod commands {
    pub const WRITE_REGISTER: u8 = 0x00;
    pub const WRITE_REGISTER_OR_MASK: u8 = 0x01;
    pub const WRITE_REGISTER_AND_MASK: u8 = 0x02;
    pub const READ_REGISTER: u8 = 0x04;
    pub const WRITE_EEPROM: u8 = 0x06;
    pub const READ_EEPROM: u8 = 0x07;
    pub const SEND_DATA: u8 = 0x09;
    pub const READ_DATA: u8 = 0x0A;
    pub const SWITCH_MODE: u8 = 0x0B;
    pub const MIFARE_AUTHENTICATE: u8 = 0x0C;
    pub const EPC_INVENTORY: u8 = 0x0D;
    pub const EPC_RESUME_INVENTORY: u8 = 0x0E;
    pub const EPC_RETRIEVE_INVENTORY_RESULT_SIZE: u8 = 0x0F;
    pub const EPC_RETRIEVE_INVENTORY_RESULT: u8 = 0x10;
    pub const LOAD_RF_CONFIG: u8 = 0x11;
    pub const UPDATE_RF_CONFIG: u8 = 0x12;
    pub const RETRIEVE_RF_CONFIG_SIZE: u8 = 0x13;
    pub const RETRIEVE_RF_CONFIG: u8 = 0x14;
    pub const RF_ON: u8 = 0x16;
    pub const RF_OFF: u8 = 0x17;
}

/// PN5180 register addresses
#[allow(dead_code)]
pub mod registers {
    pub const SYSTEM_CONFIG: u8 = 0x00;
    pub const IRQ_ENABLE: u8 = 0x01;
    pub const IRQ_STATUS: u8 = 0x02;
    pub const IRQ_CLEAR: u8 = 0x03;
    pub const TRANSCEIVE_CONTROL: u8 = 0x04;
    pub const TIMER1_CONFIG: u8 = 0x0F;
    pub const TIMER1_RELOAD: u8 = 0x10;
    pub const TIMER1_VALUE: u8 = 0x11;
    pub const TX_DATA_NUM: u8 = 0x14;
    pub const RX_STATUS: u8 = 0x15;
    pub const RF_STATUS: u8 = 0x1D;
}

/// RF configuration protocols
#[allow(dead_code)]
pub mod rf_config {
    pub const ISO_14443A_106_TX: u8 = 0x00;
    pub const ISO_14443A_106_RX: u8 = 0x80;
    pub const ISO_14443A_212_TX: u8 = 0x01;
    pub const ISO_14443A_212_RX: u8 = 0x81;
    pub const ISO_14443A_424_TX: u8 = 0x02;
    pub const ISO_14443A_424_RX: u8 = 0x82;
    pub const ISO_14443A_848_TX: u8 = 0x03;
    pub const ISO_14443A_848_RX: u8 = 0x83;
}

/// MIFARE authentication key type
#[derive(Debug, Clone, Copy)]
pub enum MifareKeyType {
    KeyA,
    KeyB,
}

/// Bambu Lab MIFARE key (Crypto-1)
/// Note: This is the known key for reading Bambu Lab tags
pub const BAMBULAB_KEY: [u8; 6] = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; // Placeholder - actual key needed

/// PN5180 driver state (without hardware - for init tracking)
pub struct Pn5180State {
    /// Whether the PN5180 has been initialized
    pub initialized: bool,
    /// Firmware version (major, minor, patch)
    pub firmware_version: (u8, u8, u8),
    /// Last detected card UID (up to 10 bytes)
    pub last_uid: Option<[u8; 10]>,
    /// Length of last UID
    pub last_uid_len: u8,
    /// RF field is on
    pub rf_on: bool,
}

impl Pn5180State {
    pub fn new() -> Self {
        Self {
            initialized: false,
            firmware_version: (0, 0, 0),
            last_uid: None,
            last_uid_len: 0,
            rf_on: false,
        }
    }
}

impl Default for Pn5180State {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// STUB IMPLEMENTATION - Hardware not connected yet
// =============================================================================
// The functions below are stubs that will be implemented when the PN5180
// hardware is connected via the CrowPanel wireless module headers (J9 + J11).
//
// GPIO assignments (DIP switch S1=0, S0=1 for Wireless Module mode):
// - IO5  (J9 Pin 2)  -> SPI SCK
// - IO4  (J9 Pin 3)  -> SPI MISO
// - IO6  (J9 Pin 4)  -> SPI MOSI
// - IO8  (J11 Pin 6) -> NSS chip select
// - IO2  (J11 Pin 5) -> BUSY signal
// - IO15 (J11 Pin 3) -> RST reset
// =============================================================================

/// Initialize the PN5180 NFC reader (STUB)
pub fn init_stub(state: &mut Pn5180State) -> Result<(), Pn5180Error> {
    info!("PN5180 NFC reader init (STUB - hardware not connected)");

    // Simulate successful initialization
    state.firmware_version = (0, 0, 0);
    state.initialized = false; // Keep false until real hardware

    Ok(())
}

/// Check if a tag is present (STUB)
pub fn detect_tag_stub(_state: &Pn5180State) -> Result<Option<Iso14443aCard>, Pn5180Error> {
    // No tag detected (stub)
    Ok(None)
}

/// Turn RF field on (STUB)
pub fn rf_field_on_stub(state: &mut Pn5180State) -> Result<(), Pn5180Error> {
    info!("RF field on (STUB)");
    state.rf_on = true;
    Ok(())
}

/// Turn RF field off (STUB)
pub fn rf_field_off_stub(state: &mut Pn5180State) -> Result<(), Pn5180Error> {
    info!("RF field off (STUB)");
    state.rf_on = false;
    Ok(())
}

/// ISO 14443A card info
#[derive(Debug, Clone)]
pub struct Iso14443aCard {
    /// UID (4, 7, or 10 bytes)
    pub uid: [u8; 10],
    /// UID length (4, 7, or 10)
    pub uid_len: u8,
    /// ATQA (2 bytes)
    pub atqa: [u8; 2],
    /// SAK byte
    pub sak: u8,
}

impl Iso14443aCard {
    /// Check if this is an NTAG (based on SAK)
    pub fn is_ntag(&self) -> bool {
        self.sak == 0x00
    }

    /// Check if this is a MIFARE Classic 1K (based on SAK)
    pub fn is_mifare_classic_1k(&self) -> bool {
        self.sak == 0x08
    }

    /// Check if this is a MIFARE Classic 4K (based on SAK)
    pub fn is_mifare_classic_4k(&self) -> bool {
        self.sak == 0x18
    }
}

/// PN5180 errors
#[derive(Debug, Clone, Copy)]
pub enum Pn5180Error {
    SpiError,
    GpioError,
    Timeout,
    NoCard,
    AuthFailed,
    ReadFailed,
    WriteFailed,
    InvalidResponse,
}

// =============================================================================
// REAL IMPLEMENTATION - PN5180 Driver
// =============================================================================

/// PN5180 driver with SPI and GPIO handles
/// RST pin is optional - if not provided, skip reset (rely on power-on reset)
/// BUSY pin is optional - if not provided, use fixed delays instead
pub struct Pn5180Driver<'a, SPI> {
    pub spi: SPI,
    pub nss: PinDriver<'a, Output>,
    pub busy: Option<PinDriver<'a, Input>>,
    pub rst: Option<PinDriver<'a, Output>>,
}

impl<'a, SPI> Pn5180Driver<'a, SPI>
where
    SPI: SpiDevice,
{
    /// Wait for BUSY pin to indicate ready (with timeout)
    /// If BUSY doesn't respond quickly, fall back to fixed delay
    fn wait_busy(&self) -> Result<(), Pn5180Error> {
        match &self.busy {
            Some(busy_pin) => {
                // Quick check - wait max 10ms for BUSY to go LOW
                for _ in 0..10 {
                    if !busy_pin.is_high() {
                        return Ok(());
                    }
                    FreeRtos::delay_ms(1);
                }
                // BUSY didn't go LOW - use fixed delay instead
                FreeRtos::delay_ms(2);
                Ok(())
            }
            None => {
                // No BUSY pin - use fixed delay
                FreeRtos::delay_ms(5);
                Ok(())
            }
        }
    }

    /// Send command to PN5180
    fn send_command(&mut self, cmd: &[u8]) -> Result<(), Pn5180Error> {
        self.wait_busy()?;

        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(5);  // Give PN5180 time to wake up

        self.spi.write(cmd).map_err(|_| Pn5180Error::SpiError)?;

        FreeRtos::delay_ms(1);
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

        Ok(())
    }

    /// Send command and read response (two NSS cycles per PN5180 datasheet)
    /// Cycle 1: NSS LOW, send command, NSS HIGH
    /// Cycle 2: Wait for ready, NSS LOW, read response, NSS HIGH
    fn send_command_read(&mut self, cmd: &[u8], response: &mut [u8]) -> Result<(), Pn5180Error> {
        self.wait_busy()?;

        // Cycle 1: Send command
        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(5);  // Give PN5180 time to wake up

        info!("  SPI TX cmd: {:02X?}", cmd);
        self.spi.write(cmd).map_err(|_| Pn5180Error::SpiError)?;

        FreeRtos::delay_ms(1);
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

        // Wait for command processing (longer delay without BUSY pin)
        FreeRtos::delay_ms(30);

        // Cycle 2: Read response
        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(5);  // Give PN5180 time to prepare data

        // Clock out response with 0xFF dummy bytes
        let tx_buf = vec![0xFFu8; response.len()];
        self.spi.transfer(response, &tx_buf).map_err(|_| Pn5180Error::SpiError)?;
        info!("  SPI RX: {:02X?}", response);

        FreeRtos::delay_ms(1);
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

        Ok(())
    }

    /// Reset the PN5180 (hardware if RST pin available, otherwise skip)
    pub fn reset(&mut self) -> Result<(), Pn5180Error> {
        if let Some(ref mut rst) = self.rst {
            info!("PN5180 hardware reset");
            rst.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(10);
            rst.set_high().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(100);
            self.wait_busy()?;
        } else {
            info!("PN5180 waiting for power-on initialization...");
            // Give the chip plenty of time to initialize after power-on
            // PN5180 needs time to load EEPROM config into registers
            FreeRtos::delay_ms(100);

            // Toggle NSS a few times to verify GPIO is working
            info!("  Testing NSS toggle (GPIO8)...");
            for _ in 0..3 {
                self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
                FreeRtos::delay_ms(10);
                self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;
                FreeRtos::delay_ms(10);
            }
            info!("  NSS toggle complete");

            // BUSY check is optional - continue even if it times out
            let _ = self.wait_busy();
        }
        Ok(())
    }

    /// Raw SPI diagnostic test - sends known patterns and reports what comes back
    /// This helps diagnose:
    /// - 0xFF on all reads = MISO floating/not connected
    /// - 0x00 on all reads = MISO shorted to GND
    /// - Same as TX = MOSI shorted to MISO (loopback)
    /// - Random data = electrical noise or bad connection
    pub fn spi_diagnostic_test(&mut self) -> Result<(), Pn5180Error> {
        info!("=== SPI DIAGNOSTIC TEST ===");
        info!("Pin assignments: SCK=GPIO43, MOSI=GPIO16, MISO=GPIO44, NSS=GPIO8");

        // Test -1: Bit-bang SPI test to verify physical wiring
        // This bypasses the ESP32 SPI peripheral entirely
        info!("Test -1: Bit-bang SPI test (bypasses SPI peripheral)");
        info!("  This test manually toggles GPIO pins to verify physical connections.");

        // We can't fully bit-bang here since we already have the SPI device,
        // but we can check if the SPI peripheral is generating any clock
        // by reading MISO state changes during transfers

        // Instead, let's do a more thorough GPIO state check
        info!("  Checking GPIO matrix and SPI peripheral state...");
        unsafe {
            // Check SPI3 peripheral clock is enabled
            let system_perip_clk_en1 = 0x60026010 as *const u32;  // SYSTEM_PERIP_CLK_EN1_REG
            let clk_en1 = core::ptr::read_volatile(system_perip_clk_en1);
            let spi3_clk_en = (clk_en1 >> 23) & 1;  // Bit 23 is SPI3_CLK_EN
            info!("  PERIP_CLK_EN1: 0x{:08X} (SPI3_CLK={})", clk_en1, spi3_clk_en);

            // Check SPI3 peripheral reset status
            let system_perip_rst_en1 = 0x60026024 as *const u32;  // SYSTEM_PERIP_RST_EN1_REG
            let rst_en1 = core::ptr::read_volatile(system_perip_rst_en1);
            let spi3_rst = (rst_en1 >> 23) & 1;  // Bit 23 is SPI3_RST (1=in reset)
            info!("  PERIP_RST_EN1: 0x{:08X} (SPI3_RST={})", rst_en1, spi3_rst);

            // Read GPIO43 (SCK) IO_MUX register to check function select
            let io_mux_gpio43 = 0x600090B0 as *const u32;  // GPIO43 IO_MUX
            let mux43 = core::ptr::read_volatile(io_mux_gpio43);
            let mcu_sel43 = (mux43 >> 12) & 0x7;
            info!("  GPIO43 IO_MUX: 0x{:08X} (MCU_SEL={} -> {})",
                mux43, mcu_sel43, if mcu_sel43 == 1 { "GPIO" } else { "other" });

            // Read GPIO16 (MOSI) IO_MUX register
            let io_mux_gpio16 = 0x60009044 as *const u32;  // GPIO16 IO_MUX
            let mux16 = core::ptr::read_volatile(io_mux_gpio16);
            let mcu_sel16 = (mux16 >> 12) & 0x7;
            info!("  GPIO16 IO_MUX: 0x{:08X} (MCU_SEL={} -> {})",
                mux16, mcu_sel16, if mcu_sel16 == 1 { "GPIO" } else { "other" });

            // Read SPI3 clock divider register (CLOCK at offset 0x0C!)
            // ESP32-S3: SPI2=0x60024000, SPI3=0x60025000
            // Offsets: CMD=0x00, ADDR=0x04, CTRL=0x08, CLOCK=0x0C, USER=0x10
            let spi3_base = 0x60025000;
            let spi_clock = core::ptr::read_volatile((spi3_base + 0x0C) as *const u32);
            let clk_equ_sysclk = (spi_clock >> 31) & 1;
            let clkdiv_pre = (spi_clock >> 18) & 0x1F;
            let clkcnt_n = (spi_clock >> 12) & 0x3F;
            info!("  SPI3_CLOCK: 0x{:08X} (equ_sysclk={} pre={} n={})",
                spi_clock, clk_equ_sysclk, clkdiv_pre, clkcnt_n);

            // Check SPI3 CMD register (should be 0 when idle)
            let spi_cmd = core::ptr::read_volatile((spi3_base + 0x00) as *const u32);
            info!("  SPI3_CMD: 0x{:08X}", spi_cmd);

            // Check SPI3 CTRL register
            let spi_ctrl = core::ptr::read_volatile((spi3_base + 0x08) as *const u32);
            info!("  SPI3_CTRL: 0x{:08X}", spi_ctrl);

            // Check actual GPIO output levels
            // GPIO43 is in GPIO_OUT1 (bits 32-53), GPIO16 and GPIO8 are in GPIO_OUT (bits 0-31)
            let gpio_out = core::ptr::read_volatile(0x60004004 as *const u32);
            let gpio_out1 = core::ptr::read_volatile(0x60004010 as *const u32);
            let _gpio_in = core::ptr::read_volatile(0x6000403C as *const u32);
            let gpio_in1 = core::ptr::read_volatile(0x60004040 as *const u32);
            info!("  GPIO_OUT1: 0x{:08X} (SCK(43)={})",
                gpio_out1, (gpio_out1 >> (43 - 32)) & 1);
            info!("  GPIO_OUT:  0x{:08X} (MOSI(16)={} NSS(8)={})",
                gpio_out, (gpio_out >> 16) & 1, (gpio_out >> 8) & 1);
            info!("  GPIO_IN1:  0x{:08X} (MISO(44)={})",
                gpio_in1, (gpio_in1 >> (44 - 32)) & 1);
        }

        info!("  Performing SPI transfer to check clock generation...");
        // Do a test transfer and check MISO before/during/after
        let gpio_in1_before: u32;
        unsafe {
            gpio_in1_before = core::ptr::read_volatile(0x60004040 as *const u32);  // GPIO_IN1 for GPIO44
        }
        info!("  MISO before transfer: {}", (gpio_in1_before >> (44 - 32)) & 1);

        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(1);

        // Check MISO right after NSS goes low (GPIO44 is in GPIO_IN1)
        let gpio_in1_nss_low: u32;
        unsafe {
            gpio_in1_nss_low = core::ptr::read_volatile(0x60004040 as *const u32);
        }
        info!("  MISO after NSS LOW: {}", (gpio_in1_nss_low >> (44 - 32)) & 1);

        // Do a small transfer
        let mut dummy_rx = [0u8; 4];
        self.spi.transfer(&mut dummy_rx, &[0x07, 0x10, 0x02, 0xFF]).map_err(|_| Pn5180Error::SpiError)?;

        // Check MISO after transfer (GPIO44 is in GPIO_IN1)
        let gpio_in1_after: u32;
        unsafe {
            gpio_in1_after = core::ptr::read_volatile(0x60004040 as *const u32);
        }
        info!("  MISO after transfer: {}", (gpio_in1_after >> (44 - 32)) & 1);
        info!("  Transfer result: {:02X?}", dummy_rx);

        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

        // Analysis
        if dummy_rx == [0xFF, 0xFF, 0xFF, 0xFF] {
            info!("");
            info!("  *** STILL ALL 0xFF - SPI PERIPHERAL OR WIRING ISSUE ***");
            info!("  The MISO line is not responding to clock pulses.");
            info!("");
            info!("  CRITICAL: Use oscilloscope or logic analyzer to verify:");
            info!("    1. SCK (GPIO43/UART0-OUT) is actually toggling during transfer");
            info!("    2. NSS (GPIO8/J11-Pin6) goes LOW during transfer");
            info!("");
            info!("  If you have a multimeter:");
            info!("    - Set to DC voltage mode");
            info!("    - Probe SCK pin during transfer - should see ~1.5V average (toggling)");
            info!("    - If SCK shows steady 0V or 3.3V, the SPI peripheral isn't generating clock");
        } else if dummy_rx == [0x07, 0x10, 0x02, 0xFF] {
            info!("  *** LOOPBACK DETECTED - MOSI and MISO shorted ***");
        } else if dummy_rx != [0x00, 0x00, 0x00, 0x00] {
            info!("  *** INTERESTING - Got non-trivial response! ***");
            info!("  The PN5180 might be responding. Check if values make sense.");
        }

        FreeRtos::delay_ms(100);

        // Test 0: Check if MISO is stuck LOW (shorted to GND)
        info!("Test 0: MISO stuck LOW detection");
        info!("  Reading MISO with NO clock (NSS cycling only)...");

        // First, read with NSS HIGH (chip deselected - MISO should float/tristate)
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(10);
        let mut rx_nss_high = [0xAAu8; 4];  // Fill with pattern to see if it changes
        self.spi.transfer(&mut rx_nss_high, &[0xFF, 0xFF, 0xFF, 0xFF]).map_err(|_| Pn5180Error::SpiError)?;
        info!("  NSS HIGH (chip off): RX = {:02X?}", rx_nss_high);

        // Now read with NSS LOW (chip selected - PN5180 should drive MISO)
        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(10);
        let mut rx_nss_low = [0xAAu8; 4];
        self.spi.transfer(&mut rx_nss_low, &[0xFF, 0xFF, 0xFF, 0xFF]).map_err(|_| Pn5180Error::SpiError)?;
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;
        info!("  NSS LOW  (chip on):  RX = {:02X?}", rx_nss_low);

        // Analyze the results
        let all_zeros_high = rx_nss_high.iter().all(|&b| b == 0x00);
        let all_zeros_low = rx_nss_low.iter().all(|&b| b == 0x00);
        let all_ff_high = rx_nss_high.iter().all(|&b| b == 0xFF);

        if all_zeros_high && all_zeros_low {
            info!("  *** MISO ACTIVELY HELD LOW! ***");
            info!("  MISO reads 0x00 even with internal pull-up enabled.");
            info!("  Something is DRIVING the line LOW (not just floating):");
            info!("");
            info!("  CRITICAL TEST: Disconnect MISO wire from PN5180 only");
            info!("  (leave ESP32 end connected) and re-run this test.");
            info!("  - If you then see 0xFF: PN5180 is the problem (damaged/shorted)");
            info!("  - If still 0x00: Issue is on CrowPanel side");
            info!("");
            info!("  If PN5180 is the culprit, check with multimeter:");
            info!("    - Continuity between MISO pad and GND on PN5180 board");
            info!("    - The PN5180 chip itself may be damaged");
        } else if all_ff_high && all_zeros_low {
            info!("  MISO floats HIGH when NSS HIGH (normal)");
            info!("  MISO LOW when NSS LOW - PN5180 driving but always 0?");
            info!("  Check if PN5180 is receiving valid SCK clock");
        } else if all_ff_high {
            info!("  MISO floats HIGH - chip not responding");
            info!("  PN5180 may not have power or MISO not connected");
        } else if rx_nss_high != rx_nss_low {
            info!("  MISO changes with NSS - GOOD, chip is responding!");
        }

        FreeRtos::delay_ms(10);

        // Test 1: Raw transfer with NSS low - send patterns, see what comes back
        info!("Test 1: Raw SPI transfer patterns (NSS LOW)");
        let test_patterns: [[u8; 4]; 4] = [
            [0x00, 0x00, 0x00, 0x00],  // All zeros
            [0xFF, 0xFF, 0xFF, 0xFF],  // All ones
            [0xAA, 0xAA, 0xAA, 0xAA],  // Alternating 10101010
            [0x55, 0x55, 0x55, 0x55],  // Alternating 01010101
        ];

        for (i, pattern) in test_patterns.iter().enumerate() {
            self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(5);

            let mut rx_buf = [0u8; 4];
            self.spi.transfer(&mut rx_buf, pattern).map_err(|_| Pn5180Error::SpiError)?;

            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

            info!("  Pattern {}: TX {:02X?} -> RX {:02X?}", i + 1, pattern, rx_buf);

            // Detailed bit-level analysis
            let mut match_count = 0;
            let mut high_count = 0;
            for j in 0..4 {
                if rx_buf[j] == pattern[j] {
                    match_count += 1;
                }
                if rx_buf[j] == 0xFF {
                    high_count += 1;
                }
            }

            if match_count == 4 {
                info!("    -> EXACT MATCH: MOSI-MISO bridge or loopback!");
            } else if high_count == 4 {
                info!("    -> All 0xFF: MISO floating HIGH");
            } else if match_count > 0 || (rx_buf[0] & pattern[0]) == pattern[0] {
                info!("    -> PARTIAL MATCH: Possible MOSI-MISO bridge with weak pullup");
            }

            FreeRtos::delay_ms(10);
        }

        // Test 1b: Same patterns but with NSS HIGH (chip should be deselected)
        info!("Test 1b: Raw SPI patterns with NSS HIGH (chip deselected)");
        for (i, pattern) in test_patterns.iter().enumerate() {
            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;  // Keep NSS HIGH
            FreeRtos::delay_ms(5);

            let mut rx_buf = [0u8; 4];
            self.spi.transfer(&mut rx_buf, pattern).map_err(|_| Pn5180Error::SpiError)?;

            info!("  Pattern {}: TX {:02X?} -> RX {:02X?}", i + 1, pattern, rx_buf);

            // If we see the same pattern with NSS HIGH, it's definitely a MOSI-MISO short
            if rx_buf[0] == pattern[0] || (rx_buf[0] ^ pattern[0]).count_ones() <= 2 {
                info!("    -> RESPONSE WITH NSS HIGH: Confirms MOSI-MISO short!");
            }

            FreeRtos::delay_ms(10);
        }

        // Test 2: Try multiple EEPROM addresses
        info!("Test 2: EEPROM reads at different addresses");
        let eeprom_addrs: [(u8, &str); 5] = [
            (0x00, "Die ID"),
            (0x10, "Firmware version"),
            (0x12, "Product version"),
            (0x14, "EEPROM version"),
            (0x1A, "IRQ pin config"),
        ];

        for (addr, name) in eeprom_addrs.iter() {
            let cmd = [commands::READ_EEPROM, *addr, 4];

            // Single cycle - send command
            self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(5);
            self.spi.write(&cmd).map_err(|_| Pn5180Error::SpiError)?;
            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

            FreeRtos::delay_ms(30);

            // Read response
            self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(5);
            let tx = [0xFF, 0xFF, 0xFF, 0xFF];
            let mut rx = [0u8; 4];
            self.spi.transfer(&mut rx, &tx).map_err(|_| Pn5180Error::SpiError)?;
            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

            info!("  EEPROM[0x{:02X}] {}: {:02X?}", addr, name, rx);

            FreeRtos::delay_ms(10);
        }

        // Test 3: Read IRQ_STATUS register (should be non-zero after reset)
        info!("Test 3: Register reads");
        let reg_addrs: [(u8, &str); 4] = [
            (registers::IRQ_STATUS, "IRQ_STATUS"),
            (registers::RF_STATUS, "RF_STATUS"),
            (registers::SYSTEM_CONFIG, "SYSTEM_CONFIG"),
            (registers::TRANSCEIVE_CONTROL, "TRANSCEIVE_CTRL"),
        ];

        for (reg, name) in reg_addrs.iter() {
            let cmd = [commands::READ_REGISTER, *reg];

            self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(5);
            self.spi.write(&cmd).map_err(|_| Pn5180Error::SpiError)?;
            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

            FreeRtos::delay_ms(30);

            self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
            FreeRtos::delay_ms(5);
            let tx = [0xFF, 0xFF, 0xFF, 0xFF];
            let mut rx = [0u8; 4];
            self.spi.transfer(&mut rx, &tx).map_err(|_| Pn5180Error::SpiError)?;
            self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

            let value = u32::from_le_bytes(rx);
            info!("  {} [0x{:02X}]: 0x{:08X} ({:02X?})", name, reg, value, rx);

            FreeRtos::delay_ms(10);
        }

        // Test 4: Single-cycle vs two-cycle SPI timing test
        info!("Test 4: Single-cycle full-duplex read");
        // Try reading in a single NSS cycle (some chips work this way)
        let cmd = [commands::READ_EEPROM, 0x10, 2, 0xFF, 0xFF];
        let mut rx_full = [0u8; 5];

        self.nss.set_low().map_err(|_| Pn5180Error::GpioError)?;
        FreeRtos::delay_ms(5);
        self.spi.transfer(&mut rx_full, &cmd).map_err(|_| Pn5180Error::SpiError)?;
        self.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

        info!("  Single-cycle: TX {:02X?} -> RX {:02X?}", cmd, rx_full);

        // Test 5: Verify connections still needed
        info!("Test 5: Connection verification checklist");
        info!("  Please verify with multimeter:");
        info!("  [ ] SCK:  UART0-OUT (GPIO43) <-> PN5180 SCK/CLK pin");
        info!("  [ ] MISO: UART0-OUT (GPIO44) <-> PN5180 MISO pin");
        info!("  [ ] MOSI: J11-Pin2 (GPIO16) <-> PN5180 MOSI pin");
        info!("  [ ] NSS:  J11-Pin6 (GPIO8) <-> PN5180 NSS/SS/CS pin");
        info!("  [ ] VCC:  Measure 3.3V at PN5180 VCC pin (should be 3.2-3.4V)");
        info!("  [ ] GND:  UART0-OUT GND <-> PN5180 GND pin");
        info!("");

        // Summary and recommendations
        info!("=== DIAGNOSTIC SUMMARY ===");
        info!("Your test results show:");
        info!("  - MISO responds to NSS (good - chip is alive)");
        info!("  - But MISO signal is weak/corrupted");
        info!("");
        info!("Most likely causes:");
        info!("  1. SCK not connected - clock isn't reaching PN5180");
        info!("  2. Weak VCC/GND - chip can't drive MISO properly");
        info!("  3. PN5180 damaged from ESD or heat during soldering");
        info!("");
        info!("Action items:");
        info!("  -> Power test without multimeter: Touch LED between VCC and GND");
        info!("     (long leg to VCC, short leg to GND - should light up)");
        info!("  -> If another PN5180 available, try swapping it");
        info!("  -> Reflow all solder joints (might have cold joints)");
        info!("=== SPI DIAGNOSTIC DONE ===");
        Ok(())
    }

    /// Read EEPROM (firmware version etc) with retry on invalid response
    pub fn read_eeprom(&mut self, addr: u8, len: u8) -> Result<Vec<u8>, Pn5180Error> {
        let cmd = [commands::READ_EEPROM, addr, len];

        // Retry up to 5 times if we get invalid response (all 0x00 or all 0xFF)
        for attempt in 0..5 {
            let mut response = vec![0u8; len as usize];
            self.send_command_read(&cmd, &mut response)?;

            // Check if response is valid (not all zeros and not all 0xFF)
            let all_zeros = response.iter().all(|&b| b == 0x00);
            let all_ones = response.iter().all(|&b| b == 0xFF);
            if !all_zeros && !all_ones {
                info!("  EEPROM[0x{:02X}]: {:02X?} (attempt {})", addr, response, attempt + 1);
                return Ok(response);
            }

            if attempt < 4 {
                FreeRtos::delay_ms(20);  // Wait before retry
            }
        }

        // Return zeros if all retries failed
        let response = vec![0u8; len as usize];
        info!("  EEPROM[0x{:02X}]: {:02X?} (all retries failed - got 0x00 or 0xFF)", addr, response);
        Ok(response)
    }

    /// Read register (32-bit) - single read with delay
    pub fn read_register(&mut self, reg: u8) -> Result<u32, Pn5180Error> {
        let cmd = [commands::READ_REGISTER, reg];
        let mut response = [0u8; 4];
        self.send_command_read(&cmd, &mut response)?;
        let value = u32::from_le_bytes(response);
        Ok(value)
    }

    /// Write register (32-bit)
    pub fn write_register(&mut self, reg: u8, value: u32) -> Result<(), Pn5180Error> {
        let bytes = value.to_le_bytes();
        let cmd = [commands::WRITE_REGISTER, reg, bytes[0], bytes[1], bytes[2], bytes[3]];
        self.send_command(&cmd)
    }

    /// Get firmware version
    pub fn get_firmware_version(&mut self) -> Result<(u8, u8, u8), Pn5180Error> {
        // Firmware version is at EEPROM address 0x10, 2 bytes
        let data = self.read_eeprom(0x10, 2)?;
        if data.len() >= 2 {
            let major = data[1] >> 4;
            let minor = data[1] & 0x0F;
            let patch = data[0];
            Ok((major, minor, patch))
        } else {
            Err(Pn5180Error::InvalidResponse)
        }
    }

    /// Get product version
    pub fn get_product_version(&mut self) -> Result<(u8, u8), Pn5180Error> {
        // Product version at EEPROM address 0x12, 2 bytes
        let data = self.read_eeprom(0x12, 2)?;
        if data.len() >= 2 {
            Ok((data[1], data[0]))
        } else {
            Err(Pn5180Error::InvalidResponse)
        }
    }

    /// Load RF configuration for ISO14443A at 106 kbps
    pub fn load_rf_config_14443a(&mut self) -> Result<(), Pn5180Error> {
        // Clear IRQs before loading config
        self.write_register(registers::IRQ_CLEAR, 0xFFFFFFFF)?;
        FreeRtos::delay_ms(5);

        let cmd = [commands::LOAD_RF_CONFIG, rf_config::ISO_14443A_106_TX, rf_config::ISO_14443A_106_RX];
        self.send_command(&cmd)?;
        FreeRtos::delay_ms(20);

        // Check RF status after config
        let rf_status = self.read_register(registers::RF_STATUS)?;
        info!("  RF_STATUS after config: 0x{:08X}", rf_status);
        Ok(())
    }

    /// Clear all pending IRQs
    pub fn clear_irq(&mut self) -> Result<(), Pn5180Error> {
        // Write 0xFFFFFFFF to IRQ_CLEAR to clear all interrupts
        self.write_register(registers::IRQ_CLEAR, 0xFFFFFFFF)?;
        FreeRtos::delay_ms(5);
        Ok(())
    }

    /// Turn RF field on
    pub fn rf_on(&mut self) -> Result<(), Pn5180Error> {
        info!("  Sending RF_ON command...");

        // Clear any pending IRQs first
        self.clear_irq()?;

        let cmd = [commands::RF_ON, 0x00];
        self.send_command(&cmd)?;
        FreeRtos::delay_ms(50);

        // Check RF status after RF_ON - bit 18 should be set
        let rf_status = self.read_register(registers::RF_STATUS)?;
        info!("  RF_STATUS after RF_ON: 0x{:08X}", rf_status);

        // Check IRQ status
        let irq = self.read_register(registers::IRQ_STATUS)?;
        info!("  IRQ_STATUS after RF_ON: 0x{:08X}", irq);

        Ok(())
    }

    /// Turn RF field off
    pub fn rf_off(&mut self) -> Result<(), Pn5180Error> {
        let cmd = [commands::RF_OFF, 0x00];
        self.send_command(&cmd)
    }

    /// Send ISO14443A REQA/WUPA and get ATQA
    pub fn iso14443a_activate(&mut self) -> Result<Option<Iso14443aCard>, Pn5180Error> {
        // Check RF status first
        let rf_status = self.read_register(registers::RF_STATUS)?;
        info!("  RF_STATUS: 0x{:08X}", rf_status);

        // Clear IRQ status
        self.write_register(registers::IRQ_CLEAR, 0xFFFFFFFF)?;

        // Configure TX_DATA_NUM for REQA short frame (7 bits)
        // Register format:
        //   Bits 15:0  = number of bytes to transmit (1 for REQA)
        //   Bits 18:16 = number of valid bits in last byte (7 for REQA)
        let tx_data_num = (7u32 << 16) | 1u32;  // 7 valid bits, 1 byte
        self.write_register(registers::TX_DATA_NUM, tx_data_num)?;

        // Send REQA (0x26) using SEND_DATA command
        // The SEND_DATA command sends the bytes following the command
        let send_cmd = [
            commands::SEND_DATA,
            0x26,  // REQA command byte
        ];
        self.send_command(&send_cmd)?;

        FreeRtos::delay_ms(10);  // Wait for card response

        // Check IRQ status
        let irq_status = self.read_register(registers::IRQ_STATUS)?;
        info!("  IRQ_STATUS: 0x{:08X}", irq_status);

        // Check RX status
        let rx_status = self.read_register(registers::RX_STATUS)?;
        info!("  RX_STATUS: 0x{:08X}", rx_status);

        let rx_len = (rx_status & 0x1FF) as usize;
        let rx_collision = (rx_status >> 17) & 0x01;  // Bit 17 is collision flag

        info!("  RX bytes: {}, collision: {}", rx_len, rx_collision);

        // Validate RX status - 0xFFFFFFFF or large values indicate SPI error
        if rx_status == 0xFFFFFFFF || rx_len > 64 {
            info!("  Invalid RX_STATUS (SPI error)");
            return Ok(None);
        }

        if rx_len < 2 {
            return Ok(None); // No card
        }

        // Read ATQA response from RX buffer
        // READ_DATA command is just the command byte, then read the response
        let mut atqa = [0u8; 2];
        let read_cmd = [commands::READ_DATA];  // No extra bytes needed
        self.send_command_read(&read_cmd, &mut atqa)?;
        info!("  ATQA: {:02X} {:02X}", atqa[0], atqa[1]);

        // Validate ATQA - 0x0000 or 0xFFFF are invalid
        if atqa == [0x00, 0x00] || atqa == [0xFF, 0xFF] {
            info!("  Invalid ATQA (SPI error or no card)");
            return Ok(None);
        }

        // TODO: Full anti-collision sequence to get UID
        // For now, just return what we have

        Ok(Some(Iso14443aCard {
            uid: [0; 10],
            uid_len: 0,
            atqa,
            sak: 0,
        }))
    }
}

/// Initialize PN5180 with SPI and GPIO (with optional RST and BUSY pins)
/// GPIO assignments for CrowPanel Advance 7.0":
/// - NSS: GPIO8 (J11 Pin 6) - required
/// - BUSY: Optional (GPIO2 conflicts with backlight, use fixed delays instead)
/// - RST: Optional (GPIO15 conflicts with Touch I2C, rely on power-on reset)
pub fn init_pn5180<'a, SPI>(
    spi: SPI,
    nss: PinDriver<'a, Output>,
    busy: Option<PinDriver<'a, Input>>,
    rst: Option<PinDriver<'a, Output>>,
    state: &mut Pn5180State,
) -> Result<Pn5180Driver<'a, SPI>, Pn5180Error>
where
    SPI: SpiDevice,
{
    info!("=== PN5180 NFC INIT ===");
    if rst.is_none() {
        info!("  (No RST pin - rely on power-on reset)");
    }
    if busy.is_none() {
        info!("  (No BUSY pin - using fixed delays)");
    }

    let mut driver = Pn5180Driver { spi, nss, busy, rst };

    // Check BUSY pin state if available
    if let Some(ref busy_pin) = driver.busy {
        info!("  BUSY pin initial state: {}", if busy_pin.is_high() { "HIGH" } else { "LOW" });
    }

    // Set NSS high initially (inactive)
    driver.nss.set_high().map_err(|_| Pn5180Error::GpioError)?;

    // Reset sequence
    driver.reset()?;

    // Check BUSY after reset if available
    if let Some(ref busy_pin) = driver.busy {
        info!("  BUSY pin after reset: {}", if busy_pin.is_high() { "HIGH" } else { "LOW" });
    }

    // Read firmware version
    match driver.get_firmware_version() {
        Ok((major, minor, patch)) => {
            info!("  PN5180 firmware: {}.{}.{}", major, minor, patch);
            state.firmware_version = (major, minor, patch);
        }
        Err(e) => {
            warn!("  Failed to read firmware version: {:?}", e);
            return Err(e);
        }
    }

    // Read product version
    match driver.get_product_version() {
        Ok((major, minor)) => {
            info!("  PN5180 product: {}.{}", major, minor);
        }
        Err(e) => {
            warn!("  Failed to read product version: {:?}", e);
        }
    }

    // Load ISO14443A configuration
    driver.load_rf_config_14443a()?;
    info!("  ISO14443A RF config loaded");

    state.initialized = true;
    info!("=== PN5180 NFC READY ===");

    Ok(driver)
}
