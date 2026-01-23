/**
 * @file ui_status_bar.c
 * @brief Global status bar for main screen and AMS overview
 *
 * Layout (800x30 bar):
 * [Backend dot]     [Colored badge + Material]     [NFC icon + label] [Scale icon + weight]
 *     Left                   Center                        Right
 */

#include "ui_status_bar.h"
#include "screens.h"
#include <lvgl.h>
#include <stdio.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_log.h"
#include "ui_internal.h"
static const char *TAG = "ui_status_bar";
#define STATUS_LOG(fmt, ...) ESP_LOGI(TAG, fmt, ##__VA_ARGS__)
#else
#include "backend_client.h"
#define STATUS_LOG(fmt, ...) printf("[status_bar] " fmt "\n", ##__VA_ARGS__)
#endif

// External functions
extern bool nfc_is_initialized(void);
extern bool nfc_tag_present(void);
extern float scale_get_weight(void);
extern bool scale_is_initialized(void);
extern int get_selected_printer_index(void);

// Colors
#define COLOR_GREEN      0x00FF00
#define COLOR_RED        0xFF0000
#define COLOR_GRAY       0x666666
#define COLOR_DARK_GRAY  0x333333
#define COLOR_WHITE      0xFFFFFF

// Static UI elements (created dynamically)
static lv_obj_t *status_bar_container = NULL;
static lv_obj_t *backend_dot = NULL;
static lv_obj_t *backend_label = NULL;
static lv_obj_t *active_tray_badge = NULL;
static lv_obj_t *active_tray_label = NULL;
static lv_obj_t *nfc_label = NULL;
static lv_obj_t *scale_label = NULL;

// Track which screen we're on
static bool current_is_main_screen = true;

// Weight display hysteresis
static float last_displayed_weight = 0.0f;
static bool weight_initialized = false;

/**
 * Get the active tray info from the selected printer
 * Returns the tray color (RGBA) and material type
 */
static bool get_active_tray_info(uint32_t *color_out, char *material_out, size_t material_size) {
#ifdef ESP_PLATFORM
    // Firmware: use backend FFI
    int printer_idx = get_selected_printer_index();
    BackendPrinterInfo info;
    if (backend_get_printer(printer_idx, &info) != 0 || !info.connected) {
        return false;
    }

    // Get tray_now values
    int tray_now = info.tray_now;
    int tray_now_left = info.tray_now_left;
    int tray_now_right = info.tray_now_right;

    // Determine which tray is active
    int active_tray = -1;
    if (tray_now >= 0 && tray_now < 255) {
        active_tray = tray_now;
    } else if (tray_now_right >= 0 && tray_now_right < 255) {
        active_tray = tray_now_right;  // Prefer right for display
    } else if (tray_now_left >= 0 && tray_now_left < 255) {
        active_tray = tray_now_left;
    }

    if (active_tray < 0) {
        return false;
    }

    // Find the tray in AMS units
    int ams_count = backend_get_ams_count(printer_idx);
    for (int ams_idx = 0; ams_idx < ams_count; ams_idx++) {
        AmsUnitCInfo ams_info;
        if (backend_get_ams_unit(printer_idx, ams_idx, &ams_info) != 0) continue;

        for (int tray_idx = 0; tray_idx < ams_info.tray_count; tray_idx++) {
            AmsTrayInfo tray_info;
            if (backend_get_ams_tray(printer_idx, ams_idx, tray_idx, &tray_info) != 0) continue;

            // Match tray: ams_id * 4 + tray_id (for regular AMS)
            int global_tray = ams_info.id * 4 + tray_idx;
            if (global_tray == active_tray) {
                // Parse color (hex string like "FF0000")
                if (tray_info.tray_color[0]) {
                    unsigned int r, g, b;
                    if (sscanf(tray_info.tray_color, "%02x%02x%02x", &r, &g, &b) == 3) {
                        *color_out = (r << 16) | (g << 8) | b;
                    } else {
                        *color_out = COLOR_GRAY;
                    }
                } else {
                    *color_out = COLOR_GRAY;
                }

                // Copy material
                if (tray_info.tray_type[0]) {
                    strncpy(material_out, tray_info.tray_type, material_size - 1);
                    material_out[material_size - 1] = '\0';
                } else {
                    strncpy(material_out, "Empty", material_size - 1);
                }

                return true;
            }
        }
    }

    return false;
#else
    // Simulator: use backend_client
    int printer_idx = get_selected_printer_index();
    const BackendState *state = backend_get_state();
    if (!state || printer_idx < 0 || printer_idx >= state->printer_count) {
        return false;
    }

    const BackendPrinterState *printer = &state->printers[printer_idx];
    if (!printer->connected) {
        return false;
    }

    // Determine which tray is active
    int active_tray = -1;
    if (printer->tray_now >= 0 && printer->tray_now < 255) {
        active_tray = printer->tray_now;
    } else if (printer->tray_now_right >= 0 && printer->tray_now_right < 255) {
        active_tray = printer->tray_now_right;
    } else if (printer->tray_now_left >= 0 && printer->tray_now_left < 255) {
        active_tray = printer->tray_now_left;
    }

    if (active_tray < 0) {
        return false;
    }

    // Find the tray in AMS units
    for (int ams_idx = 0; ams_idx < printer->ams_unit_count; ams_idx++) {
        const BackendAmsUnit *ams = &printer->ams_units[ams_idx];
        for (int tray_idx = 0; tray_idx < ams->tray_count; tray_idx++) {
            const BackendAmsTray *tray = &ams->trays[tray_idx];

            // Match tray
            int global_tray = ams->id * 4 + tray_idx;
            if (global_tray == active_tray) {
                // Parse color
                if (tray->tray_color[0]) {
                    unsigned int r, g, b;
                    if (sscanf(tray->tray_color, "%02x%02x%02x", &r, &g, &b) == 3) {
                        *color_out = (r << 16) | (g << 8) | b;
                    } else {
                        *color_out = COLOR_GRAY;
                    }
                } else {
                    *color_out = COLOR_GRAY;
                }

                // Copy material - prefer tray_sub_brands (e.g. "Bambu PLA Basic"), fallback to tray_type
                if (tray->tray_sub_brands[0]) {
                    strncpy(material_out, tray->tray_sub_brands, material_size - 1);
                    material_out[material_size - 1] = '\0';
                } else if (tray->tray_type[0]) {
                    strncpy(material_out, tray->tray_type, material_size - 1);
                    material_out[material_size - 1] = '\0';
                } else {
                    strncpy(material_out, "Empty", material_size - 1);
                }

                return true;
            }
        }
    }

    return false;
#endif
}

/**
 * Check if backend is connected
 */
static bool is_backend_connected(void) {
#ifdef ESP_PLATFORM
    BackendStatus status;
    backend_get_status(&status);
    return status.state == 2;  // Connected
#else
    return backend_is_connected();
#endif
}

void ui_status_bar_init(bool is_main_screen) {
    // Clean up any existing status bar first
    ui_status_bar_cleanup();

    current_is_main_screen = is_main_screen;

    // Get the bottom bar container for this screen
    lv_obj_t *bottom_bar = is_main_screen ? objects.bottom_bar : objects.ams_screen_bottom_bar;
    if (!bottom_bar) {
        STATUS_LOG("No bottom bar found for %s", is_main_screen ? "main_screen" : "ams_overview");
        return;
    }

    // Verify the bottom bar belongs to the active screen
    lv_obj_t *screen = lv_obj_get_screen(bottom_bar);
    if (!screen || screen != lv_scr_act()) {
        STATUS_LOG("Bottom bar not on active screen for %s", is_main_screen ? "main_screen" : "ams_overview");
        return;
    }

    // Hide existing elements (LED and message) - we'll replace them
    if (is_main_screen) {
        if (objects.bottom_bar_message_dot) lv_obj_add_flag(objects.bottom_bar_message_dot, LV_OBJ_FLAG_HIDDEN);
        if (objects.bottom_bar_message) lv_obj_add_flag(objects.bottom_bar_message, LV_OBJ_FLAG_HIDDEN);
    } else {
        if (objects.ams_screen_bottom_bar_led) lv_obj_add_flag(objects.ams_screen_bottom_bar_led, LV_OBJ_FLAG_HIDDEN);
        if (objects.ams_screen_bottom_bar_message) lv_obj_add_flag(objects.ams_screen_bottom_bar_message, LV_OBJ_FLAG_HIDDEN);
    }

    status_bar_container = bottom_bar;

    // =========================================================================
    // LEFT: Backend connection dot + label
    // =========================================================================
    backend_dot = lv_obj_create(bottom_bar);
    lv_obj_remove_style_all(backend_dot);
    lv_obj_set_size(backend_dot, 8, 8);
    lv_obj_align(backend_dot, LV_ALIGN_LEFT_MID, 10, 0);
    lv_obj_set_style_radius(backend_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(backend_dot, lv_color_hex(COLOR_GRAY), 0);
    lv_obj_set_style_bg_opa(backend_dot, 255, 0);
    lv_obj_set_style_border_width(backend_dot, 0, 0);

    backend_label = lv_label_create(bottom_bar);
    lv_obj_align(backend_label, LV_ALIGN_LEFT_MID, 22, 0);
    lv_label_set_text(backend_label, "Server");
    lv_obj_set_style_text_color(backend_label, lv_color_hex(COLOR_WHITE), 0);
    lv_obj_set_style_text_font(backend_label, &lv_font_montserrat_12, 0);

    // =========================================================================
    // CENTER: Active tray badge (square) + material label
    // =========================================================================
    active_tray_badge = lv_obj_create(bottom_bar);
    lv_obj_remove_style_all(active_tray_badge);
    lv_obj_set_size(active_tray_badge, 14, 14);
    lv_obj_align(active_tray_badge, LV_ALIGN_CENTER, -50, 0);
    lv_obj_set_style_radius(active_tray_badge, 2, 0);  // Square with slight rounding
    lv_obj_set_style_bg_color(active_tray_badge, lv_color_hex(COLOR_DARK_GRAY), 0);
    lv_obj_set_style_bg_opa(active_tray_badge, 255, 0);
    lv_obj_set_style_border_width(active_tray_badge, 1, 0);
    lv_obj_set_style_border_color(active_tray_badge, lv_color_hex(0x555555), 0);

    // Material label (positioned right next to badge with small gap)
    active_tray_label = lv_label_create(bottom_bar);
    lv_obj_align_to(active_tray_label, active_tray_badge, LV_ALIGN_OUT_RIGHT_MID, 6, 0);  // 6px gap after badge
    lv_label_set_text(active_tray_label, "---");
    lv_obj_set_style_text_color(active_tray_label, lv_color_hex(COLOR_GRAY), 0);
    lv_obj_set_style_text_font(active_tray_label, &lv_font_montserrat_12, 0);

    // =========================================================================
    // RIGHT: NFC status text + Scale weight text (no icons)
    // =========================================================================
    // NFC status label
    nfc_label = lv_label_create(bottom_bar);
    lv_obj_align(nfc_label, LV_ALIGN_RIGHT_MID, -110, 0);
    lv_label_set_text(nfc_label, "NFC: Ready");
    lv_obj_set_style_text_color(nfc_label, lv_color_hex(COLOR_GRAY), 0);
    lv_obj_set_style_text_font(nfc_label, &lv_font_montserrat_12, 0);

    // Scale weight label
    scale_label = lv_label_create(bottom_bar);
    lv_obj_align(scale_label, LV_ALIGN_RIGHT_MID, -12, 0);
    lv_label_set_text(scale_label, "Scale: N/A");
    lv_obj_set_style_text_color(scale_label, lv_color_hex(COLOR_GRAY), 0);
    lv_obj_set_style_text_font(scale_label, &lv_font_montserrat_12, 0);

    STATUS_LOG("Status bar initialized for %s", is_main_screen ? "main_screen" : "ams_overview");
}

void ui_status_bar_update(void) {
    if (!status_bar_container) return;

    // Verify the container is still valid (attached to an active screen)
    lv_obj_t *screen = lv_obj_get_screen(status_bar_container);
    if (!screen || screen != lv_scr_act()) {
        // Container belongs to a deleted/inactive screen - clear and return
        ui_status_bar_cleanup();
        return;
    }

    // =========================================================================
    // Update backend connection dot
    // =========================================================================
    if (backend_dot) {
        bool connected = is_backend_connected();
        lv_obj_set_style_bg_color(backend_dot,
            lv_color_hex(connected ? COLOR_GREEN : COLOR_RED), 0);
    }

    // =========================================================================
    // Update active tray badge and material
    // =========================================================================
    if (active_tray_badge && active_tray_label) {
        uint32_t tray_color = COLOR_DARK_GRAY;
        char material[64] = "---";

        if (get_active_tray_info(&tray_color, material, sizeof(material))) {
            lv_obj_set_style_bg_color(active_tray_badge, lv_color_hex(tray_color), 0);
            lv_obj_set_style_border_color(active_tray_badge, lv_color_hex(0x888888), 0);
            lv_label_set_text(active_tray_label, material);
            lv_obj_set_style_text_color(active_tray_label, lv_color_hex(COLOR_WHITE), 0);
        } else {
            lv_obj_set_style_bg_color(active_tray_badge, lv_color_hex(COLOR_DARK_GRAY), 0);
            lv_obj_set_style_border_color(active_tray_badge, lv_color_hex(0x555555), 0);
            lv_label_set_text(active_tray_label, "---");
            lv_obj_set_style_text_color(active_tray_label, lv_color_hex(COLOR_GRAY), 0);
        }
    }

    // =========================================================================
    // Update NFC status text
    // =========================================================================
    if (nfc_label) {
        bool nfc_ready = nfc_is_initialized();
        bool tag_present = nfc_ready && nfc_tag_present();

        if (tag_present) {
            lv_label_set_text(nfc_label, "NFC: Tag");
            lv_obj_set_style_text_color(nfc_label, lv_color_hex(COLOR_GREEN), 0);
        } else if (nfc_ready) {
            lv_label_set_text(nfc_label, "NFC: Ready");
            lv_obj_set_style_text_color(nfc_label, lv_color_hex(COLOR_WHITE), 0);
        } else {
            lv_label_set_text(nfc_label, "NFC: N/A");
            lv_obj_set_style_text_color(nfc_label, lv_color_hex(COLOR_GRAY), 0);
        }
    }

    // =========================================================================
    // Update scale weight text
    // =========================================================================
    if (scale_label) {
        if (scale_is_initialized()) {
            float weight = scale_get_weight();

            // Apply 10g hysteresis
            float diff = weight - last_displayed_weight;
            if (diff < 0) diff = -diff;

            if (!weight_initialized || diff >= 10.0f) {
                last_displayed_weight = weight;
                weight_initialized = true;

                int weight_int = (int)weight;
                if (weight_int >= -20 && weight_int <= 20) weight_int = 0;
                if (weight_int < 0) weight_int = 0;

                char weight_str[24];
                snprintf(weight_str, sizeof(weight_str), "Scale: %dg", weight_int);
                lv_label_set_text(scale_label, weight_str);
            }
            lv_obj_set_style_text_color(scale_label, lv_color_hex(COLOR_WHITE), 0);
        } else {
            lv_label_set_text(scale_label, "Scale: N/A");
            lv_obj_set_style_text_color(scale_label, lv_color_hex(COLOR_GRAY), 0);
        }
    }
}

void ui_status_bar_cleanup(void) {
    // Elements are children of bottom_bar, they get deleted with screen
    // Just clear our pointers
    status_bar_container = NULL;
    backend_dot = NULL;
    backend_label = NULL;
    active_tray_badge = NULL;
    active_tray_label = NULL;
    nfc_label = NULL;
    scale_label = NULL;
    weight_initialized = false;
    last_displayed_weight = 0.0f;

    STATUS_LOG("Status bar cleaned up");
}
