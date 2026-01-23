/**
 * NFC Card UI - Main screen NFC/Scale card management
 * Shows a popup when NFC tag is detected
 */

#include "ui_nfc_card.h"
#include "screens.h"
#include "lvgl.h"
#include <stdio.h>
#include <string.h>
#include "esp_log.h"

#ifdef ESP_PLATFORM
#include "ui_internal.h"
// Type aliases for unified API
typedef SpoolInfoC SpoolInfoLocal;
typedef SpoolKProfileC SpoolKProfileLocal;
#define spool_get_by_tag_local spool_get_by_tag
#define spool_get_k_profile_local spool_get_k_profile_for_printer
#else
#include "backend_client.h"
// Type aliases for unified API
typedef SpoolInfo SpoolInfoLocal;
typedef SpoolKProfile SpoolKProfileLocal;
#define spool_get_by_tag_local spool_get_by_tag_full
#define spool_get_k_profile_local spool_get_k_profile_for_printer_full
#endif

static const char *TAG = "ui_nfc_card";

// External Rust FFI functions - NFC
extern bool nfc_is_initialized(void);
extern bool nfc_tag_present(void);
extern uint8_t nfc_get_uid_hex(uint8_t *buf, uint8_t buf_len);

// Decoded tag data (Rust FFI on ESP32, mock on simulator)
extern const char* nfc_get_tag_vendor(void);
extern const char* nfc_get_tag_material(void);
extern const char* nfc_get_tag_color_name(void);
extern uint32_t nfc_get_tag_color_rgba(void);

// External Rust FFI functions - Scale
extern float scale_get_weight(void);
extern bool scale_is_initialized(void);
extern bool scale_is_stable(void);

// Get selected printer index for K-profile lookup
extern int get_selected_printer_index(void);

// Spool images for popup display
extern const lv_image_dsc_t img_spool_clean;
extern const lv_image_dsc_t img_spool_fill;

// Screen navigation
extern enum ScreensEnum pendingScreen;

// Static state
static bool last_tag_present = false;
static uint8_t popup_tag_uid[32] = {0};  // UID of tag that opened the popup
static bool popup_user_closed = false;    // User manually closed the popup
static char configured_tag_id[32] = {0};  // Tag that was just configured (suppress popup)
static uint32_t tag_lost_time = 0;        // Timestamp when tag was lost (for debounce)
static char dismissed_tag_uid[32] = {0};  // UID of tag that was dismissed (survives brief losses)

// Debounce time for tag removal (ms) - suppression cleared after tag gone this long
#define TAG_REMOVAL_DEBOUNCE_MS 2000

// Popup elements
static lv_obj_t *tag_popup = NULL;
static lv_obj_t *popup_tag_label = NULL;
static lv_obj_t *popup_weight_label = NULL;

// Link spool selection popup
static lv_obj_t *link_popup = NULL;
static UntaggedSpoolInfo untagged_spools[20];  // Cache of untagged spools
static int untagged_spools_count = 0;

// Tag details modal (read-only view)
static lv_obj_t *details_modal = NULL;
static char details_modal_spool_id[64] = {0};  // For sync button

// Close handler for details modal
static void details_modal_close_handler(lv_event_t *e) {
    (void)e;
    if (details_modal) {
        lv_obj_delete(details_modal);
        details_modal = NULL;
    }
}

// Sync weight button handler
static void sync_weight_click_handler(lv_event_t *e) {
    (void)e;
    if (details_modal_spool_id[0] == '\0') return;

    float weight = scale_get_weight();
    int weight_int = (int)weight;
    if (weight_int >= -20 && weight_int <= 20) weight_int = 0;
    if (weight_int < 0) weight_int = 0;

    ESP_LOGI(TAG, "Syncing weight %dg for spool %s", weight_int, details_modal_spool_id);

    if (spool_sync_weight(details_modal_spool_id, weight_int)) {
        ESP_LOGI(TAG, "Weight synced successfully");
        // Close and reopen to refresh
        details_modal_close_handler(NULL);
        ui_nfc_card_show_details();
    } else {
        ESP_LOGE(TAG, "Failed to sync weight");
    }
}

// Show tag details modal (read-only, just Close button)
void ui_nfc_card_show_details(void) {
    if (details_modal) return;  // Already open

    // Check if tag is present
    bool tag_present = nfc_tag_present();

    // Get tag UID if present
    uint8_t uid_str[32] = {0};
    bool tag_in_inventory = false;
    if (tag_present) {
        nfc_get_uid_hex(uid_str, sizeof(uid_str));
        tag_in_inventory = spool_exists_by_tag((const char*)uid_str);
    }

    // Get weight
    float weight = scale_get_weight();
    bool scale_ok = scale_is_initialized();
    int scale_weight = 0;
    if (scale_ok) {
        scale_weight = (int)weight;
        if (scale_weight >= -20 && scale_weight <= 20) scale_weight = 0;
        if (scale_weight < 0) scale_weight = 0;
    }

    ESP_LOGI(TAG, "Opening tag details modal (tag_present=%d, in_inventory=%d)", tag_present, tag_in_inventory);

    // Create modal background
    details_modal = lv_obj_create(lv_layer_top());
    lv_obj_set_size(details_modal, 800, 480);
    lv_obj_set_pos(details_modal, 0, 0);
    lv_obj_set_style_bg_color(details_modal, lv_color_hex(0x000000), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(details_modal, 180, LV_PART_MAIN);
    lv_obj_set_style_border_width(details_modal, 0, LV_PART_MAIN);
    lv_obj_clear_flag(details_modal, LV_OBJ_FLAG_SCROLLABLE);

    // Click on background closes modal
    lv_obj_add_event_cb(details_modal, details_modal_close_handler, LV_EVENT_CLICKED, NULL);

    // Determine card size based on state
    int card_height = 400;  // Default for "Ready to scan"
    if (tag_present) {
        card_height = tag_in_inventory ? 420 : 220;
    }

    // Create card
    lv_obj_t *card = lv_obj_create(details_modal);
    lv_obj_set_size(card, 480, card_height);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 20, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    // Prevent clicks on card from closing
    lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(card, NULL, LV_EVENT_CLICKED, NULL);

    // Title
    lv_obj_t *title = lv_label_create(card);
    lv_label_set_text(title, tag_present ? "Current Spool" : "Current Spool");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0xfafafa), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

    if (!tag_present) {
        // No tag present - show "Ready to scan" state (matches frontend Dashboard)

        // Container for colored circle + wave rings
        lv_obj_t *scan_container = lv_obj_create(card);
        lv_obj_set_size(scan_container, 180, 180);
        lv_obj_align(scan_container, LV_ALIGN_TOP_MID, 0, 30);
        lv_obj_set_style_bg_opa(scan_container, 0, 0);
        lv_obj_set_style_border_width(scan_container, 0, 0);
        lv_obj_set_style_pad_all(scan_container, 0, 0);
        lv_obj_clear_flag(scan_container, LV_OBJ_FLAG_SCROLLABLE);

        // Outer gray ring
        lv_obj_t *ring1 = lv_obj_create(scan_container);
        lv_obj_remove_style_all(ring1);
        lv_obj_set_size(ring1, 170, 170);
        lv_obj_center(ring1);
        lv_obj_set_style_radius(ring1, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(ring1, 1, 0);
        lv_obj_set_style_border_color(ring1, lv_color_hex(0x444444), 0);
        lv_obj_set_style_border_opa(ring1, 180, 0);
        lv_obj_set_style_bg_opa(ring1, 0, 0);
        lv_obj_clear_flag(ring1, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

        // Middle gray ring
        lv_obj_t *ring2 = lv_obj_create(scan_container);
        lv_obj_remove_style_all(ring2);
        lv_obj_set_size(ring2, 130, 130);
        lv_obj_center(ring2);
        lv_obj_set_style_radius(ring2, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(ring2, 1, 0);
        lv_obj_set_style_border_color(ring2, lv_color_hex(0x555555), 0);
        lv_obj_set_style_border_opa(ring2, 200, 0);
        lv_obj_set_style_bg_opa(ring2, 0, 0);
        lv_obj_clear_flag(ring2, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

        // Inner ring (outline around colored circle)
        lv_obj_t *ring3 = lv_obj_create(scan_container);
        lv_obj_remove_style_all(ring3);
        lv_obj_set_size(ring3, 90, 90);
        lv_obj_center(ring3);
        lv_obj_set_style_radius(ring3, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_border_width(ring3, 3, 0);
        lv_obj_set_style_border_color(ring3, lv_color_hex(0x666666), 0);
        lv_obj_set_style_border_opa(ring3, 255, 0);
        lv_obj_set_style_bg_opa(ring3, 0, 0);
        lv_obj_clear_flag(ring3, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

        // Colored filled circle in center (like frontend's SpoolIcon)
        lv_obj_t *color_circle = lv_obj_create(scan_container);
        lv_obj_remove_style_all(color_circle);
        lv_obj_set_size(color_circle, 80, 80);
        lv_obj_center(color_circle);
        lv_obj_set_style_radius(color_circle, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_color(color_circle, lv_color_hex(0x4A90D9), 0);  // Blue color
        lv_obj_set_style_bg_opa(color_circle, 255, 0);
        lv_obj_clear_flag(color_circle, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

        // "Ready to scan" text
        lv_obj_t *ready_label = lv_label_create(card);
        lv_label_set_text(ready_label, "Ready to scan");
        lv_obj_set_style_text_font(ready_label, &lv_font_montserrat_18, LV_PART_MAIN);
        lv_obj_set_style_text_color(ready_label, lv_color_hex(0xaaaaaa), LV_PART_MAIN);
        lv_obj_align(ready_label, LV_ALIGN_TOP_MID, 0, 215);

        // "Place a spool on the scale" text
        lv_obj_t *hint_label = lv_label_create(card);
        lv_label_set_text(hint_label, "Place a spool on the scale to identify it");
        lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_12, LV_PART_MAIN);
        lv_obj_set_style_text_color(hint_label, lv_color_hex(0x666666), LV_PART_MAIN);
        lv_obj_align(hint_label, LV_ALIGN_TOP_MID, 0, 240);

        // "NFC tag will be read automatically" hint
        lv_obj_t *nfc_hint = lv_label_create(card);
        lv_label_set_text(nfc_hint, LV_SYMBOL_WARNING " NFC tag will be read automatically");
        lv_obj_set_style_text_font(nfc_hint, &lv_font_montserrat_10, LV_PART_MAIN);
        lv_obj_set_style_text_color(nfc_hint, lv_color_hex(0x555555), LV_PART_MAIN);
        lv_obj_align(nfc_hint, LV_ALIGN_TOP_MID, 0, 270);

        // Close button
        lv_obj_t *btn_close = lv_btn_create(card);
        lv_obj_set_size(btn_close, 100, 36);
        lv_obj_align(btn_close, LV_ALIGN_BOTTOM_MID, 0, -5);
        lv_obj_set_style_bg_color(btn_close, lv_color_hex(0x555555), 0);
        lv_obj_set_style_radius(btn_close, 18, 0);
        lv_obj_add_event_cb(btn_close, details_modal_close_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *close_label = lv_label_create(btn_close);
        lv_label_set_text(close_label, "Close");
        lv_obj_set_style_text_font(close_label, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(close_label, lv_color_hex(0xFFFFFF), 0);
        lv_obj_center(close_label);

    } else if (tag_in_inventory) {
        // Get spool data from inventory
        SpoolInfoLocal spool_info = {0};
        spool_get_by_tag_local((const char*)uid_str, &spool_info);

        // Store spool ID for sync button
        strncpy(details_modal_spool_id, spool_info.id, sizeof(details_modal_spool_id) - 1);

        // Get K profile for selected printer
        SpoolKProfileLocal k_profile = {0};
        bool has_k_profile = false;
        int printer_idx = get_selected_printer_index();
        if (printer_idx >= 0 && spool_info.id[0]) {
            BackendPrinterInfo printer_info = {0};
            if (backend_get_printer(printer_idx, &printer_info) == 0) {
                has_k_profile = spool_get_k_profile_local(spool_info.id, printer_info.serial, &k_profile);
            }
        }

        // Color from inventory
        uint32_t color_rgba = spool_info.color_rgba;
        uint8_t r = (color_rgba >> 24) & 0xFF;
        uint8_t g = (color_rgba >> 16) & 0xFF;
        uint8_t b = (color_rgba >> 8) & 0xFF;
        uint32_t color_hex = (r << 16) | (g << 8) | b;
        if (color_rgba == 0) color_hex = 0x808080;

        // Top section: Spool icon + details side by side
        lv_obj_t *top_section = lv_obj_create(card);
        lv_obj_set_size(top_section, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_align(top_section, LV_ALIGN_TOP_MID, 0, 28);
        lv_obj_set_style_bg_opa(top_section, 0, 0);
        lv_obj_set_style_border_width(top_section, 0, 0);
        lv_obj_set_style_pad_all(top_section, 0, 0);
        lv_obj_clear_flag(top_section, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(top_section, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(top_section, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
        lv_obj_set_style_pad_column(top_section, 16, 0);

        // Spool image container
        lv_obj_t *spool_container = lv_obj_create(top_section);
        lv_obj_set_size(spool_container, 70, 84);
        lv_obj_set_style_bg_opa(spool_container, 0, 0);
        lv_obj_set_style_border_width(spool_container, 0, 0);
        lv_obj_set_style_pad_all(spool_container, 0, 0);
        lv_obj_clear_flag(spool_container, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *spool_outline = lv_image_create(spool_container);
        lv_image_set_src(spool_outline, &img_spool_clean);
        lv_image_set_pivot(spool_outline, 0, 0);
        lv_image_set_scale(spool_outline, 420);
        lv_obj_set_pos(spool_outline, 0, 0);

        lv_obj_t *spool_fill = lv_image_create(spool_container);
        lv_image_set_src(spool_fill, &img_spool_fill);
        lv_image_set_pivot(spool_fill, 0, 0);
        lv_image_set_scale(spool_fill, 420);
        lv_obj_set_pos(spool_fill, 0, 0);
        lv_obj_set_style_image_recolor(spool_fill, lv_color_hex(color_hex), 0);
        lv_obj_set_style_image_recolor_opa(spool_fill, 255, 0);

        // Details container (right of spool)
        lv_obj_t *details_container = lv_obj_create(top_section);
        lv_obj_set_size(details_container, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(details_container, 0, 0);
        lv_obj_set_style_border_width(details_container, 0, 0);
        lv_obj_set_style_pad_all(details_container, 0, 0);
        lv_obj_clear_flag(details_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(details_container, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_row(details_container, 2, 0);

        // Helper macro for detail rows with fixed-width label
        #define CREATE_DETAIL_ROW(label_text, value_text) do { \
            lv_obj_t *row = lv_obj_create(details_container); \
            lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT); \
            lv_obj_set_style_bg_opa(row, 0, 0); \
            lv_obj_set_style_border_width(row, 0, 0); \
            lv_obj_set_style_pad_all(row, 0, 0); \
            lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE); \
            lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW); \
            lv_obj_set_style_pad_column(row, 6, 0); \
            lv_obj_t *lbl = lv_label_create(row); \
            lv_label_set_text(lbl, label_text); \
            lv_obj_set_style_text_font(lbl, &lv_font_montserrat_12, 0); \
            lv_obj_set_style_text_color(lbl, lv_color_hex(0x777777), 0); \
            lv_obj_set_width(lbl, 60); \
            lv_obj_t *val = lv_label_create(row); \
            lv_label_set_text(val, value_text); \
            lv_obj_set_style_text_font(val, &lv_font_montserrat_12, 0); \
            lv_obj_set_style_text_color(val, lv_color_hex(0xfafafa), 0); \
        } while(0)

        CREATE_DETAIL_ROW("Brand", spool_info.brand[0] ? spool_info.brand : "-");
        CREATE_DETAIL_ROW("Material", spool_info.material[0] ? spool_info.material : "-");
        CREATE_DETAIL_ROW("Color", spool_info.color_name[0] ? spool_info.color_name : "-");

        // Tag row (smaller font, dimmer)
        lv_obj_t *tag_row = lv_obj_create(details_container);
        lv_obj_set_size(tag_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(tag_row, 0, 0);
        lv_obj_set_style_border_width(tag_row, 0, 0);
        lv_obj_set_style_pad_all(tag_row, 0, 0);
        lv_obj_clear_flag(tag_row, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(tag_row, LV_FLEX_FLOW_ROW);
        lv_obj_set_style_pad_column(tag_row, 6, 0);
        lv_obj_set_style_pad_top(tag_row, 4, 0);
        lv_obj_t *tag_lbl = lv_label_create(tag_row);
        lv_label_set_text(tag_lbl, "Tag");
        lv_obj_set_style_text_font(tag_lbl, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(tag_lbl, lv_color_hex(0x666666), 0);
        lv_obj_set_width(tag_lbl, 60);
        lv_obj_t *tag_val = lv_label_create(tag_row);
        lv_label_set_text(tag_val, (const char*)uid_str);
        lv_obj_set_style_text_font(tag_val, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(tag_val, lv_color_hex(0x999999), 0);

        // K profile info (if available)
        if (has_k_profile && k_profile.name[0]) {
            lv_obj_t *k_row = lv_obj_create(details_container);
            lv_obj_set_size(k_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
            lv_obj_set_style_bg_opa(k_row, 0, 0);
            lv_obj_set_style_border_width(k_row, 0, 0);
            lv_obj_set_style_pad_all(k_row, 0, 0);
            lv_obj_clear_flag(k_row, LV_OBJ_FLAG_SCROLLABLE);
            lv_obj_set_flex_flow(k_row, LV_FLEX_FLOW_ROW);
            lv_obj_set_style_pad_column(k_row, 6, 0);
            lv_obj_set_style_pad_top(k_row, 4, 0);
            lv_obj_t *k_lbl = lv_label_create(k_row);
            lv_label_set_text(k_lbl, "K Profile");
            lv_obj_set_style_text_font(k_lbl, &lv_font_montserrat_10, 0);
            lv_obj_set_style_text_color(k_lbl, lv_color_hex(0x666666), 0);
            lv_obj_set_width(k_lbl, 60);
            char k_text[80];
            snprintf(k_text, sizeof(k_text), "%s (k=%s)", k_profile.name, k_profile.k_value[0] ? k_profile.k_value : "-");
            lv_obj_t *k_val = lv_label_create(k_row);
            lv_label_set_text(k_val, k_text);
            lv_obj_set_style_text_font(k_val, &lv_font_montserrat_10, 0);
            lv_obj_set_style_text_color(k_val, lv_color_hex(0x4CAF50), 0);
        }

        #undef CREATE_DETAIL_ROW

        // Divider line
        lv_obj_t *divider = lv_obj_create(card);
        lv_obj_set_size(divider, LV_PCT(90), 1);
        lv_obj_align(divider, LV_ALIGN_TOP_MID, 0, 155);
        lv_obj_set_style_bg_color(divider, lv_color_hex(0x444444), 0);
        lv_obj_set_style_bg_opa(divider, 255, 0);
        lv_obj_set_style_border_width(divider, 0, 0);

        // Fill level section
        lv_obj_t *fill_section = lv_obj_create(card);
        lv_obj_set_size(fill_section, LV_PCT(90), 50);
        lv_obj_align(fill_section, LV_ALIGN_TOP_MID, 0, 165);
        lv_obj_set_style_bg_opa(fill_section, 0, 0);
        lv_obj_set_style_border_width(fill_section, 0, 0);
        lv_obj_set_style_pad_all(fill_section, 0, 0);
        lv_obj_clear_flag(fill_section, LV_OBJ_FLAG_SCROLLABLE);

        // Calculate fill percentage
        int fill_pct = 0;
        if (spool_info.label_weight > 0 && scale_ok) {
            int filament_weight = scale_weight - 200;  // ~200g core
            if (filament_weight < 0) filament_weight = 0;
            fill_pct = (filament_weight * 100) / spool_info.label_weight;
            if (fill_pct > 100) fill_pct = 100;
            if (fill_pct < 0) fill_pct = 0;
        }

        lv_obj_t *fill_label = lv_label_create(fill_section);
        lv_label_set_text(fill_label, "Fill Level");
        lv_obj_set_style_text_font(fill_label, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(fill_label, lv_color_hex(0x777777), 0);
        lv_obj_align(fill_label, LV_ALIGN_TOP_LEFT, 0, 0);

        char fill_str[16];
        snprintf(fill_str, sizeof(fill_str), "%d%%", fill_pct);
        lv_obj_t *fill_pct_label = lv_label_create(fill_section);
        lv_label_set_text(fill_pct_label, fill_str);
        lv_obj_set_style_text_font(fill_pct_label, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(fill_pct_label, lv_color_hex(0xfafafa), 0);
        lv_obj_align(fill_pct_label, LV_ALIGN_TOP_RIGHT, 0, 0);

        // Progress bar with full rounded corners
        lv_obj_t *bar = lv_bar_create(fill_section);
        lv_obj_set_size(bar, LV_PCT(100), 20);
        lv_obj_align(bar, LV_ALIGN_TOP_LEFT, 0, 20);
        lv_bar_set_range(bar, 0, 100);
        lv_bar_set_value(bar, fill_pct, LV_ANIM_OFF);
        lv_obj_set_style_bg_color(bar, lv_color_hex(0x2a2a2a), LV_PART_MAIN);
        lv_obj_set_style_bg_color(bar, lv_color_hex(color_hex), LV_PART_INDICATOR);
        lv_obj_set_style_radius(bar, 10, LV_PART_MAIN);
        lv_obj_set_style_radius(bar, 10, LV_PART_INDICATOR);

        // Weight comparison section
        lv_obj_t *weight_section = lv_obj_create(card);
        lv_obj_set_size(weight_section, LV_PCT(90), 55);
        lv_obj_align(weight_section, LV_ALIGN_TOP_MID, 0, 230);
        lv_obj_set_style_bg_opa(weight_section, 0, 0);
        lv_obj_set_style_border_width(weight_section, 0, 0);
        lv_obj_set_style_pad_all(weight_section, 0, 0);
        lv_obj_clear_flag(weight_section, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *weight_title = lv_label_create(weight_section);
        lv_label_set_text(weight_title, "Weight");
        lv_obj_set_style_text_font(weight_title, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(weight_title, lv_color_hex(0x777777), 0);
        lv_obj_align(weight_title, LV_ALIGN_TOP_LEFT, 0, 0);

        // Row container for weights
        lv_obj_t *weight_row = lv_obj_create(weight_section);
        lv_obj_set_size(weight_row, LV_PCT(100), 28);
        lv_obj_align(weight_row, LV_ALIGN_TOP_LEFT, 0, 18);
        lv_obj_set_style_bg_opa(weight_row, 0, 0);
        lv_obj_set_style_border_width(weight_row, 0, 0);
        lv_obj_set_style_pad_all(weight_row, 0, 0);
        lv_obj_clear_flag(weight_row, LV_OBJ_FLAG_SCROLLABLE);

        // Scale weight
        char scale_str[32];
        snprintf(scale_str, sizeof(scale_str), "%dg", scale_weight);
        lv_obj_t *scale_val = lv_label_create(weight_row);
        lv_label_set_text(scale_val, scale_str);
        lv_obj_set_style_text_font(scale_val, &lv_font_montserrat_16, 0);
        lv_obj_set_style_text_color(scale_val, lv_color_hex(0xfafafa), 0);
        lv_obj_align(scale_val, LV_ALIGN_LEFT_MID, 0, 0);

        lv_obj_t *scale_lbl = lv_label_create(weight_row);
        lv_label_set_text(scale_lbl, "scale");
        lv_obj_set_style_text_font(scale_lbl, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(scale_lbl, lv_color_hex(0x666666), 0);
        lv_obj_align(scale_lbl, LV_ALIGN_LEFT_MID, 50, 0);

        // Inventory weight
        char inv_str[32];
        snprintf(inv_str, sizeof(inv_str), "%dg", spool_info.weight_current);
        lv_obj_t *inv_val = lv_label_create(weight_row);
        lv_label_set_text(inv_val, inv_str);
        lv_obj_set_style_text_font(inv_val, &lv_font_montserrat_16, 0);
        lv_obj_set_style_text_color(inv_val, lv_color_hex(0xfafafa), 0);
        lv_obj_align(inv_val, LV_ALIGN_LEFT_MID, 110, 0);

        lv_obj_t *inv_lbl = lv_label_create(weight_row);
        lv_label_set_text(inv_lbl, "inventory");
        lv_obj_set_style_text_font(inv_lbl, &lv_font_montserrat_10, 0);
        lv_obj_set_style_text_color(inv_lbl, lv_color_hex(0x666666), 0);
        lv_obj_align(inv_lbl, LV_ALIGN_LEFT_MID, 160, 0);

        // Mismatch indicator and sync button
        int weight_diff = scale_weight - spool_info.weight_current;
        int abs_diff = weight_diff < 0 ? -weight_diff : weight_diff;

        if (abs_diff > 10 && scale_ok) {
            char diff_str[24];
            snprintf(diff_str, sizeof(diff_str), "%+dg", weight_diff);
            lv_obj_t *diff_label = lv_label_create(weight_row);
            lv_label_set_text(diff_label, diff_str);
            lv_obj_set_style_text_font(diff_label, &lv_font_montserrat_12, 0);
            lv_obj_set_style_text_color(diff_label, lv_color_hex(0xFF9800), 0);
            lv_obj_align(diff_label, LV_ALIGN_LEFT_MID, 240, 0);

            lv_obj_t *btn_sync = lv_btn_create(weight_row);
            lv_obj_set_size(btn_sync, 60, 26);
            lv_obj_align(btn_sync, LV_ALIGN_RIGHT_MID, 0, 0);
            lv_obj_set_style_bg_color(btn_sync, lv_color_hex(0x1E88E5), 0);
            lv_obj_set_style_radius(btn_sync, 13, 0);
            lv_obj_add_event_cb(btn_sync, sync_weight_click_handler, LV_EVENT_CLICKED, NULL);

            lv_obj_t *sync_label = lv_label_create(btn_sync);
            lv_label_set_text(sync_label, "Sync");
            lv_obj_set_style_text_font(sync_label, &lv_font_montserrat_12, 0);
            lv_obj_set_style_text_color(sync_label, lv_color_hex(0xFFFFFF), 0);
            lv_obj_center(sync_label);
        } else if (scale_ok) {
            lv_obj_t *match = lv_label_create(weight_row);
            lv_label_set_text(match, LV_SYMBOL_OK " Match");
            lv_obj_set_style_text_font(match, &lv_font_montserrat_12, 0);
            lv_obj_set_style_text_color(match, lv_color_hex(0x4CAF50), 0);
            lv_obj_align(match, LV_ALIGN_RIGHT_MID, 0, 0);
        }

        // Close button
        lv_obj_t *btn_close = lv_btn_create(card);
        lv_obj_set_size(btn_close, 100, 36);
        lv_obj_align(btn_close, LV_ALIGN_BOTTOM_MID, 0, -5);
        lv_obj_set_style_bg_color(btn_close, lv_color_hex(0x555555), 0);
        lv_obj_set_style_radius(btn_close, 18, 0);
        lv_obj_add_event_cb(btn_close, details_modal_close_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *close_label = lv_label_create(btn_close);
        lv_label_set_text(close_label, "Close");
        lv_obj_set_style_text_font(close_label, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(close_label, lv_color_hex(0xFFFFFF), 0);
        lv_obj_center(close_label);

    } else {
        // Unknown tag - show tag ID and weight only
        lv_obj_t *tag_id_label = lv_label_create(card);
        char tag_text[64];
        snprintf(tag_text, sizeof(tag_text), "Tag ID: %s", uid_str);
        lv_label_set_text(tag_id_label, tag_text);
        lv_obj_set_style_text_font(tag_id_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(tag_id_label, lv_color_hex(0xfafafa), LV_PART_MAIN);
        lv_obj_align(tag_id_label, LV_ALIGN_TOP_MID, 0, 45);

        char weight_str[32];
        if (scale_ok) {
            snprintf(weight_str, sizeof(weight_str), "Weight: %dg", scale_weight);
        } else {
            snprintf(weight_str, sizeof(weight_str), "Weight: N/A");
        }
        lv_obj_t *weight_label = lv_label_create(card);
        lv_label_set_text(weight_label, weight_str);
        lv_obj_set_style_text_font(weight_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(weight_label, lv_color_hex(0xfafafa), LV_PART_MAIN);
        lv_obj_align(weight_label, LV_ALIGN_TOP_MID, 0, 70);

        lv_obj_t *hint = lv_label_create(card);
        lv_label_set_text(hint, "Tag not in inventory");
        lv_obj_set_style_text_font(hint, &lv_font_montserrat_12, LV_PART_MAIN);
        lv_obj_set_style_text_color(hint, lv_color_hex(0xFF9800), LV_PART_MAIN);
        lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, 100);

        // Close button - with more space above
        lv_obj_t *btn_close = lv_btn_create(card);
        lv_obj_set_size(btn_close, 120, 42);
        lv_obj_align(btn_close, LV_ALIGN_BOTTOM_MID, 0, 0);
        lv_obj_set_style_bg_color(btn_close, lv_color_hex(0x666666), LV_PART_MAIN);
        lv_obj_set_style_radius(btn_close, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(btn_close, details_modal_close_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *close_label = lv_label_create(btn_close);
        lv_label_set_text(close_label, "Close");
        lv_obj_set_style_text_font(close_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(close_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_center(close_label);
    }
}

// Button click handlers
static void popup_close_handler(lv_event_t *e) {
    (void)e;
    ESP_LOGI(TAG, "popup_close_handler called, dismissing tag %s", popup_tag_uid);
    popup_user_closed = true;  // Remember user closed it
    // Remember which tag was dismissed (survives brief NFC reader glitches)
    strncpy(dismissed_tag_uid, (char*)popup_tag_uid, sizeof(dismissed_tag_uid) - 1);
    dismissed_tag_uid[sizeof(dismissed_tag_uid) - 1] = '\0';
    if (tag_popup) {
        lv_obj_delete(tag_popup);
        tag_popup = NULL;
        popup_tag_label = NULL;
        popup_weight_label = NULL;
    }
}

static void configure_ams_click_handler(lv_event_t *e) {
    (void)e;
    // Close popup first
    popup_close_handler(NULL);
    // Navigate to scan_result screen (Encode Tag)
    pendingScreen = SCREEN_ID_SCAN_RESULT;
}

// Forward declarations
static void show_success_overlay(const char *message);
static void show_link_spool_popup(void);

static void add_spool_click_handler(lv_event_t *e) {
    (void)e;
    ESP_LOGI(TAG, "Add Spool clicked");

    // Get current weight
    float weight = scale_get_weight();
    bool scale_ok = scale_is_initialized();
    int weight_current = scale_ok ? (int)weight : 0;
    if (weight_current >= -20 && weight_current <= 20) weight_current = 0;

    // Add spool with minimal info - tag_id and weight only
    // User will configure details via frontend
    bool success = spool_add_to_inventory(
        (const char*)popup_tag_uid,  // tag_id
        "Unknown",                    // vendor
        "Unknown",                    // material
        NULL,                         // subtype
        "Unknown",                    // color_name
        0x808080FF,                   // color_rgba (gray)
        1000,                         // label_weight (default 1kg)
        weight_current,               // weight_current from scale
        "display_add",                // data_origin
        "generic",                    // tag_type
        NULL                          // slicer_filament
    );

    if (success) {
        ESP_LOGI(TAG, "Spool added successfully");
        show_success_overlay("Spool Added!\nConfigure details in web UI.");
    } else {
        ESP_LOGE(TAG, "Failed to add spool");
        show_success_overlay("Failed to add spool.\nPlease try again.");
    }
}

static void link_spool_click_handler(lv_event_t *e) {
    (void)e;
    ESP_LOGI(TAG, "Link to Spool clicked");
    show_link_spool_popup();
}

// Close popup if open
static void close_popup(void) {
    if (tag_popup) {
        lv_obj_delete(tag_popup);
        tag_popup = NULL;
        popup_tag_label = NULL;
        popup_weight_label = NULL;
    }
}

// ============================================================================
// Success overlay - shows feedback after add/link actions
// ============================================================================

static void success_overlay_timer_cb(lv_timer_t *timer) {
    // Delete timer first to prevent repeat firing (LVGL timers repeat by default)
    lv_timer_delete(timer);

    // Close the main popup
    if (tag_popup) {
        lv_obj_delete(tag_popup);
        tag_popup = NULL;
        popup_tag_label = NULL;
        popup_weight_label = NULL;
    }
    popup_user_closed = true;
    // Remember which tag was dismissed (survives brief NFC reader glitches)
    strncpy(dismissed_tag_uid, (char*)popup_tag_uid, sizeof(dismissed_tag_uid) - 1);
    dismissed_tag_uid[sizeof(dismissed_tag_uid) - 1] = '\0';
}

static void show_success_overlay(const char *message) {
    // Replace card content with success message
    if (!tag_popup) return;

    // Find and delete the card (first child that's not the background)
    uint32_t child_count = lv_obj_get_child_count(tag_popup);
    for (uint32_t i = 0; i < child_count; i++) {
        lv_obj_t *child = lv_obj_get_child(tag_popup, i);
        if (child) {
            lv_obj_delete(child);
            break;  // Only delete the card
        }
    }

    // Create success card
    lv_obj_t *card = lv_obj_create(tag_popup);
    lv_obj_set_size(card, 350, 180);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(0x4CAF50), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 20, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    // Checkmark icon (using text)
    lv_obj_t *icon = lv_label_create(card);
    lv_label_set_text(icon, LV_SYMBOL_OK);
    lv_obj_set_style_text_font(icon, &lv_font_montserrat_28, LV_PART_MAIN);
    lv_obj_set_style_text_color(icon, lv_color_hex(0x4CAF50), LV_PART_MAIN);
    lv_obj_align(icon, LV_ALIGN_TOP_MID, 0, 10);

    // Message
    lv_obj_t *msg = lv_label_create(card);
    lv_label_set_text(msg, message);
    lv_obj_set_style_text_font(msg, &lv_font_montserrat_16, LV_PART_MAIN);
    lv_obj_set_style_text_color(msg, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
    lv_obj_set_style_text_align(msg, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(msg, LV_ALIGN_CENTER, 0, 20);

    // Auto-close after 2 seconds
    lv_timer_create(success_overlay_timer_cb, 2000, tag_popup);
}

// ============================================================================
// Link spool popup - shows list of untagged spools to select from
// ============================================================================

static void link_popup_close_handler(lv_event_t *e) {
    (void)e;
    if (link_popup) {
        lv_obj_delete(link_popup);
        link_popup = NULL;
    }
}

static void spool_item_click_handler(lv_event_t *e) {
    int spool_index = (int)(intptr_t)lv_event_get_user_data(e);

    if (spool_index < 0 || spool_index >= untagged_spools_count) {
        ESP_LOGE(TAG, "Invalid spool index: %d", spool_index);
        return;
    }

    UntaggedSpoolInfo *spool = &untagged_spools[spool_index];
    ESP_LOGI(TAG, "Linking tag %s to spool %s (%s %s)",
             popup_tag_uid, spool->id, spool->brand, spool->material);

    // Link the tag to this spool
    bool success = spool_link_tag(spool->id, (const char*)popup_tag_uid, "generic");

    // Close link popup
    if (link_popup) {
        lv_obj_delete(link_popup);
        link_popup = NULL;
    }

    if (success) {
        char msg[128];
        snprintf(msg, sizeof(msg), "Tag Linked!\n%s %s", spool->brand, spool->material);
        show_success_overlay(msg);
    } else {
        show_success_overlay("Failed to link tag.\nPlease try again.");
    }
}

static void show_link_spool_popup(void) {
    if (link_popup) return;  // Already open

    // Fetch untagged spools
    untagged_spools_count = spool_get_untagged_list(untagged_spools, 20);
    ESP_LOGI(TAG, "Found %d untagged spools", untagged_spools_count);

    if (untagged_spools_count == 0) {
        ESP_LOGW(TAG, "No untagged spools available");
        return;
    }

    // Create modal overlay
    link_popup = lv_obj_create(lv_layer_top());
    lv_obj_set_size(link_popup, 800, 480);
    lv_obj_set_pos(link_popup, 0, 0);
    lv_obj_set_style_bg_color(link_popup, lv_color_hex(0x000000), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(link_popup, 200, LV_PART_MAIN);
    lv_obj_set_style_border_width(link_popup, 0, LV_PART_MAIN);
    lv_obj_clear_flag(link_popup, LV_OBJ_FLAG_SCROLLABLE);

    // Click on background closes
    lv_obj_add_event_cb(link_popup, link_popup_close_handler, LV_EVENT_CLICKED, NULL);

    // Create selection card
    lv_obj_t *card = lv_obj_create(link_popup);
    int card_height = 120 + (untagged_spools_count > 5 ? 5 : untagged_spools_count) * 55;
    if (card_height > 400) card_height = 400;
    lv_obj_set_size(card, 500, card_height);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(0x1976D2), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 15, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);

    // Title
    lv_obj_t *title = lv_label_create(card);
    lv_label_set_text(title, "Link to Spool");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x1976D2), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

    // Scrollable list container
    lv_obj_t *list = lv_obj_create(card);
    lv_obj_set_size(list, LV_PCT(100), card_height - 100);
    lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 35);
    lv_obj_set_style_bg_opa(list, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(list, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(list, 0, LV_PART_MAIN);
    lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(list, 8, LV_PART_MAIN);
    lv_obj_add_flag(list, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(list, LV_DIR_VER);

    // Create list items
    for (int i = 0; i < untagged_spools_count; i++) {
        UntaggedSpoolInfo *spool = &untagged_spools[i];

        lv_obj_t *item = lv_btn_create(list);
        lv_obj_set_size(item, LV_PCT(100), 50);
        lv_obj_set_style_bg_color(item, lv_color_hex(0x2a2a2a), LV_PART_MAIN);
        lv_obj_set_style_radius(item, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(item, spool_item_click_handler, LV_EVENT_CLICKED, (void*)(intptr_t)i);

        // Color indicator
        lv_obj_t *color_dot = lv_obj_create(item);
        lv_obj_remove_style_all(color_dot);  // Remove default styles to prevent artifacts
        lv_obj_set_size(color_dot, 24, 24);
        lv_obj_align(color_dot, LV_ALIGN_LEFT_MID, 10, 0);
        lv_obj_set_style_radius(color_dot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(color_dot, LV_OPA_COVER, LV_PART_MAIN);
        uint32_t rgba = spool->color_rgba;
        uint8_t r = (rgba >> 24) & 0xFF;
        uint8_t g = (rgba >> 16) & 0xFF;
        uint8_t b = (rgba >> 8) & 0xFF;
        lv_obj_set_style_bg_color(color_dot, lv_color_make(r, g, b), LV_PART_MAIN);
        lv_obj_clear_flag(color_dot, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

        // Spool info
        lv_obj_t *info = lv_label_create(item);
        char info_text[128];
        snprintf(info_text, sizeof(info_text), "%s %s - %s",
                 spool->brand[0] ? spool->brand : "Unknown",
                 spool->material[0] ? spool->material : "Unknown",
                 spool->color_name[0] ? spool->color_name : "Unknown");
        lv_label_set_text(info, info_text);
        lv_obj_set_style_text_font(info, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(info, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_align(info, LV_ALIGN_LEFT_MID, 45, 0);
    }

    // Cancel button
    lv_obj_t *btn_cancel = lv_btn_create(card);
    lv_obj_set_size(btn_cancel, 120, 38);
    lv_obj_align(btn_cancel, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_bg_color(btn_cancel, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_set_style_radius(btn_cancel, 8, LV_PART_MAIN);
    lv_obj_add_event_cb(btn_cancel, link_popup_close_handler, LV_EVENT_CLICKED, NULL);

    lv_obj_t *cancel_label = lv_label_create(btn_cancel);
    lv_label_set_text(cancel_label, "Cancel");
    lv_obj_set_style_text_font(cancel_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(cancel_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
    lv_obj_center(cancel_label);
}

// Material subtype
extern const char* nfc_get_tag_material_subtype(void);

// Create the tag detected popup - two views based on inventory status
static void create_tag_popup(void) {
    if (tag_popup) return;  // Already open

    ESP_LOGI(TAG, "Creating tag popup");

    // Get tag UID and store it
    uint8_t uid_str[32];
    nfc_get_uid_hex(uid_str, sizeof(uid_str));
    strncpy((char*)popup_tag_uid, (char*)uid_str, sizeof(popup_tag_uid) - 1);
    popup_tag_uid[sizeof(popup_tag_uid) - 1] = '\0';

    // Check if tag is in inventory FIRST
    bool tag_in_inventory = spool_exists_by_tag((const char*)uid_str);
    int untagged_count = spool_get_untagged_count();

    ESP_LOGI(TAG, "Tag %s: in_inventory=%d, untagged_count=%d", uid_str, tag_in_inventory, untagged_count);

    // Get weight
    float weight = scale_get_weight();
    bool scale_ok = scale_is_initialized();

    // Create modal background (semi-transparent overlay)
    tag_popup = lv_obj_create(lv_layer_top());
    lv_obj_set_size(tag_popup, 800, 480);
    lv_obj_set_pos(tag_popup, 0, 0);
    lv_obj_set_style_bg_color(tag_popup, lv_color_hex(0x000000), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(tag_popup, 180, LV_PART_MAIN);
    lv_obj_set_style_border_width(tag_popup, 0, LV_PART_MAIN);
    lv_obj_clear_flag(tag_popup, LV_OBJ_FLAG_SCROLLABLE);

    // Click on background closes popup
    lv_obj_add_event_cb(tag_popup, popup_close_handler, LV_EVENT_CLICKED, NULL);

    // Create popup card (centered)
    lv_obj_t *card = lv_obj_create(tag_popup);
    lv_obj_set_size(card, 450, tag_in_inventory ? 300 : 250);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, tag_in_inventory ? lv_color_hex(0x4CAF50) : lv_color_hex(0xFF9800), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 20, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    // Prevent clicks on card from closing popup
    lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(card, NULL, LV_EVENT_CLICKED, NULL);  // Absorb click

    // No longer need dynamic weight updates
    popup_tag_label = NULL;
    popup_weight_label = NULL;

    if (tag_in_inventory) {
        // =====================================================================
        // VIEW 1: Tag found in inventory - show spool details
        // =====================================================================

        // Get spool data from inventory (not from NFC tag)
        SpoolInfoLocal spool_info = {0};
        spool_get_by_tag_local((const char*)uid_str, &spool_info);

        // Title - green for known spool
        lv_obj_t *title = lv_label_create(card);
        lv_label_set_text(title, "Spool Recognized");
        lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(title, lv_color_hex(0x4CAF50), LV_PART_MAIN);
        lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

        // Container for spool icon + details (centered)
        lv_obj_t *content_container = lv_obj_create(card);
        lv_obj_set_size(content_container, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_align(content_container, LV_ALIGN_TOP_MID, 0, 35);
        lv_obj_set_style_bg_opa(content_container, 0, LV_PART_MAIN);
        lv_obj_set_style_border_width(content_container, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(content_container, 0, LV_PART_MAIN);
        lv_obj_clear_flag(content_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(content_container, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(content_container, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_column(content_container, 15, LV_PART_MAIN);

        // Spool image container
        lv_obj_t *spool_container = lv_obj_create(content_container);
        lv_obj_set_size(spool_container, 50, 60);
        lv_obj_set_style_bg_opa(spool_container, 0, LV_PART_MAIN);
        lv_obj_set_style_border_width(spool_container, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(spool_container, 0, LV_PART_MAIN);
        lv_obj_clear_flag(spool_container, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *spool_outline = lv_image_create(spool_container);
        lv_image_set_src(spool_outline, &img_spool_clean);
        lv_image_set_scale(spool_outline, 300);
        lv_obj_set_pos(spool_outline, 0, 0);

        lv_obj_t *spool_fill = lv_image_create(spool_container);
        lv_image_set_src(spool_fill, &img_spool_fill);
        lv_image_set_scale(spool_fill, 300);
        lv_obj_set_pos(spool_fill, 0, 0);

        // Color from inventory
        uint32_t color_rgba = spool_info.color_rgba;
        uint8_t r = (color_rgba >> 24) & 0xFF;
        uint8_t g = (color_rgba >> 16) & 0xFF;
        uint8_t b = (color_rgba >> 8) & 0xFF;
        uint32_t color_hex = (r << 16) | (g << 8) | b;
        if (color_rgba != 0) {
            lv_obj_set_style_image_recolor(spool_fill, lv_color_hex(color_hex), 0);
            lv_obj_set_style_image_recolor_opa(spool_fill, 255, 0);
        } else {
            lv_obj_set_style_image_recolor(spool_fill, lv_color_hex(0x808080), 0);
            lv_obj_set_style_image_recolor_opa(spool_fill, 255, 0);
        }

        // Spool details from inventory
        lv_obj_t *details_container = lv_obj_create(content_container);
        lv_obj_set_size(details_container, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(details_container, 0, 0);
        lv_obj_set_style_border_width(details_container, 0, 0);
        lv_obj_set_style_pad_all(details_container, 0, 0);
        lv_obj_clear_flag(details_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(details_container, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_row(details_container, 4, 0);

        #define CREATE_DETAIL_ROW(label_text, value_text) do { \
            lv_obj_t *row = lv_obj_create(details_container); \
            lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT); \
            lv_obj_set_style_bg_opa(row, 0, 0); \
            lv_obj_set_style_border_width(row, 0, 0); \
            lv_obj_set_style_pad_all(row, 0, 0); \
            lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE); \
            lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW); \
            lv_obj_set_style_pad_column(row, 4, 0); \
            lv_obj_t *lbl = lv_label_create(row); \
            lv_label_set_text(lbl, label_text); \
            lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0); \
            lv_obj_set_style_text_color(lbl, lv_color_hex(0x888888), 0); \
            lv_obj_t *val = lv_label_create(row); \
            lv_label_set_text(val, value_text); \
            lv_obj_set_style_text_font(val, &lv_font_montserrat_14, 0); \
            lv_obj_set_style_text_color(val, lv_color_hex(0xfafafa), 0); \
        } while(0)

        char weight_str[32];
        if (scale_ok) {
            int weight_int = (int)weight;
            if (weight_int >= -20 && weight_int <= 20) weight_int = 0;
            snprintf(weight_str, sizeof(weight_str), "%dg", weight_int);
        } else {
            snprintf(weight_str, sizeof(weight_str), "N/A");
        }

        CREATE_DETAIL_ROW("Brand:", spool_info.brand[0] ? spool_info.brand : "Unknown");
        CREATE_DETAIL_ROW("Material:", spool_info.material[0] ? spool_info.material : "Unknown");
        CREATE_DETAIL_ROW("Color:", spool_info.color_name[0] ? spool_info.color_name : "Unknown");
        CREATE_DETAIL_ROW("Weight:", weight_str);

        #undef CREATE_DETAIL_ROW

        // Buttons for known spool: Config AMS + Close
        lv_obj_t *btn_container = lv_obj_create(card);
        lv_obj_set_size(btn_container, LV_PCT(100), 50);
        lv_obj_align(btn_container, LV_ALIGN_BOTTOM_MID, 0, 0);
        lv_obj_set_style_bg_opa(btn_container, 0, LV_PART_MAIN);
        lv_obj_set_style_border_width(btn_container, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(btn_container, 0, LV_PART_MAIN);
        lv_obj_clear_flag(btn_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(btn_container, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(btn_container, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        int btn_width = 180;

        // "Config AMS" button - enabled
        lv_obj_t *btn_ams = lv_btn_create(btn_container);
        lv_obj_set_size(btn_ams, btn_width, 42);
        lv_obj_set_style_bg_color(btn_ams, lv_color_hex(0x1E88E5), LV_PART_MAIN);
        lv_obj_set_style_radius(btn_ams, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(btn_ams, configure_ams_click_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *ams_label = lv_label_create(btn_ams);
        lv_label_set_text(ams_label, "Config AMS");
        lv_obj_set_style_text_font(ams_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(ams_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_center(ams_label);

        // "Close" button
        lv_obj_t *btn_close = lv_btn_create(btn_container);
        lv_obj_set_size(btn_close, btn_width, 42);
        lv_obj_set_style_bg_color(btn_close, lv_color_hex(0x666666), LV_PART_MAIN);
        lv_obj_set_style_radius(btn_close, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(btn_close, popup_close_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *close_label = lv_label_create(btn_close);
        lv_label_set_text(close_label, "Close");
        lv_obj_set_style_text_font(close_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(close_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_center(close_label);

    } else {
        // =====================================================================
        // VIEW 2: Tag NOT in inventory - show unknown tag view
        // =====================================================================

        // Title - orange for unknown tag
        lv_obj_t *title = lv_label_create(card);
        lv_label_set_text(title, "Unknown Tag");
        lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(title, lv_color_hex(0xFF9800), LV_PART_MAIN);
        lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

        // Tag ID display
        lv_obj_t *tag_id_label = lv_label_create(card);
        char tag_text[64];
        snprintf(tag_text, sizeof(tag_text), "Tag ID: %s", uid_str);
        lv_label_set_text(tag_id_label, tag_text);
        lv_obj_set_style_text_font(tag_id_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(tag_id_label, lv_color_hex(0xAAAAAA), LV_PART_MAIN);
        lv_obj_align(tag_id_label, LV_ALIGN_TOP_MID, 0, 35);

        // Weight display
        lv_obj_t *weight_label = lv_label_create(card);
        char weight_str[32];
        if (scale_ok) {
            int weight_int = (int)weight;
            if (weight_int >= -20 && weight_int <= 20) weight_int = 0;
            snprintf(weight_str, sizeof(weight_str), "Scale: %dg", weight_int);
        } else {
            snprintf(weight_str, sizeof(weight_str), "Scale: N/A");
        }
        lv_label_set_text(weight_label, weight_str);
        lv_obj_set_style_text_font(weight_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(weight_label, lv_color_hex(0xAAAAAA), LV_PART_MAIN);
        lv_obj_align(weight_label, LV_ALIGN_TOP_MID, 0, 55);

        // Hint message
        lv_obj_t *hint_label = lv_label_create(card);
        lv_label_set_text(hint_label, "Tag not in inventory.\nLink or add, then edit in frontend.");
        lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_12, LV_PART_MAIN);
        lv_obj_set_style_text_color(hint_label, lv_color_hex(0x888888), LV_PART_MAIN);
        lv_obj_set_style_text_align(hint_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
        lv_obj_align(hint_label, LV_ALIGN_CENTER, 0, -10);

        // Buttons for unknown tag: Add Spool, Link to Spool, Close
        lv_obj_t *btn_container = lv_obj_create(card);
        lv_obj_set_size(btn_container, LV_PCT(100), 50);
        lv_obj_align(btn_container, LV_ALIGN_BOTTOM_MID, 0, 0);
        lv_obj_set_style_bg_opa(btn_container, 0, LV_PART_MAIN);
        lv_obj_set_style_border_width(btn_container, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(btn_container, 0, LV_PART_MAIN);
        lv_obj_clear_flag(btn_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_flex_flow(btn_container, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(btn_container, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        int btn_width = 130;

        // "Add Spool" button - always enabled for unknown tags
        lv_obj_t *btn_add = lv_btn_create(btn_container);
        lv_obj_set_size(btn_add, btn_width, 42);
        lv_obj_set_style_bg_color(btn_add, lv_color_hex(0x2D5A27), LV_PART_MAIN);
        lv_obj_set_style_radius(btn_add, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(btn_add, add_spool_click_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *add_label = lv_label_create(btn_add);
        lv_label_set_text(add_label, "Add Spool");
        lv_obj_set_style_text_font(add_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(add_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_center(add_label);

        // "Link to Spool" button - enabled only if there are untagged spools
        lv_obj_t *btn_link = lv_btn_create(btn_container);
        lv_obj_set_size(btn_link, btn_width, 42);
        lv_obj_set_style_radius(btn_link, 8, LV_PART_MAIN);
        bool link_enabled = (untagged_count > 0);
        if (link_enabled) {
            lv_obj_set_style_bg_color(btn_link, lv_color_hex(0x1976D2), LV_PART_MAIN);
            lv_obj_add_event_cb(btn_link, link_spool_click_handler, LV_EVENT_CLICKED, NULL);
        } else {
            lv_obj_set_style_bg_color(btn_link, lv_color_hex(0x444444), LV_PART_MAIN);
            lv_obj_set_style_bg_opa(btn_link, 128, LV_PART_MAIN);
            lv_obj_clear_flag(btn_link, LV_OBJ_FLAG_CLICKABLE);
        }

        lv_obj_t *link_label = lv_label_create(btn_link);
        lv_label_set_text(link_label, "Link Spool");
        lv_obj_set_style_text_font(link_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(link_label, link_enabled ? lv_color_hex(0xFFFFFF) : lv_color_hex(0x888888), LV_PART_MAIN);
        lv_obj_center(link_label);

        // "Close" button
        lv_obj_t *btn_close = lv_btn_create(btn_container);
        lv_obj_set_size(btn_close, btn_width, 42);
        lv_obj_set_style_bg_color(btn_close, lv_color_hex(0x666666), LV_PART_MAIN);
        lv_obj_set_style_radius(btn_close, 8, LV_PART_MAIN);
        lv_obj_add_event_cb(btn_close, popup_close_handler, LV_EVENT_CLICKED, NULL);

        lv_obj_t *close_label = lv_label_create(btn_close);
        lv_label_set_text(close_label, "Close");
        lv_obj_set_style_text_font(close_label, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_set_style_text_color(close_label, lv_color_hex(0xFFFFFF), LV_PART_MAIN);
        lv_obj_center(close_label);
    }

    ESP_LOGI(TAG, "Tag popup created successfully");
}

// Update weight display in popup if open
static void update_popup_weight(void) {
    if (!popup_weight_label) return;

    float weight = scale_get_weight();
    bool scale_ok = scale_is_initialized();

    char weight_text[64];
    if (scale_ok) {
        int weight_int = (int)weight;
        // Show 0 if weight is between -20 and +20 (noise threshold)
        if (weight_int >= -20 && weight_int <= 20) weight_int = 0;
        snprintf(weight_text, sizeof(weight_text), "Weight: %dg", weight_int);
    } else {
        snprintf(weight_text, sizeof(weight_text), "Weight: N/A (scale not ready)");
    }
    lv_label_set_text(popup_weight_label, weight_text);
}

void ui_nfc_card_init(void) {
    last_tag_present = false;
    // Don't reset configured_tag_id - it needs to persist across screen transitions
    close_popup();
}

// Mark a tag as "just configured" to suppress popup when returning to main screen
void ui_nfc_card_set_configured_tag(const char *tag_id) {
    if (tag_id && tag_id[0]) {
        strncpy(configured_tag_id, tag_id, sizeof(configured_tag_id) - 1);
        configured_tag_id[sizeof(configured_tag_id) - 1] = '\0';
        strncpy((char*)popup_tag_uid, tag_id, sizeof(popup_tag_uid) - 1);
        popup_tag_uid[sizeof(popup_tag_uid) - 1] = '\0';
        // Also set dismissed_tag_uid so it survives brief NFC glitches
        strncpy(dismissed_tag_uid, tag_id, sizeof(dismissed_tag_uid) - 1);
        dismissed_tag_uid[sizeof(dismissed_tag_uid) - 1] = '\0';
        ESP_LOGI(TAG, "Suppressing popup for tag: %s", configured_tag_id);
    }
}

void ui_nfc_card_cleanup(void) {
    close_popup();
    last_tag_present = false;
    // Don't reset configured_tag_id - it needs to persist across screen transitions
}

void ui_nfc_card_update(void) {
    if (!nfc_is_initialized()) {
        ESP_LOGD(TAG, "NFC not initialized, skipping update");
        return;
    }

    bool tag_present = nfc_tag_present();

    // Get current tag UID
    uint8_t current_uid[32] = {0};
    if (tag_present) {
        nfc_get_uid_hex(current_uid, sizeof(current_uid));
    }

    // Log state changes
    if (tag_present != last_tag_present) {
        ESP_LOGI(TAG, "Tag state changed: present=%d, uid=%s, popup=%p, user_closed=%d",
                 tag_present, current_uid, (void*)tag_popup, popup_user_closed);
    }

    // Tag detected
    if (tag_present) {
        // Tag is present - reset lost timer
        tag_lost_time = 0;

        // Check if this tag should be suppressed (just configured OR user dismissed it)
        bool is_suppressed = false;

        // Suppress if this is the configured tag
        if (configured_tag_id[0] != '\0' &&
            strcmp((char*)current_uid, configured_tag_id) == 0) {
            is_suppressed = true;
        }

        // Suppress if this is the dismissed tag (survives brief NFC glitches)
        if (dismissed_tag_uid[0] != '\0' &&
            strcmp((char*)current_uid, dismissed_tag_uid) == 0) {
            is_suppressed = true;
        }

        // Check if this is a different tag than the dismissed one
        bool is_different_tag = (dismissed_tag_uid[0] != '\0') &&
                                (strcmp((char*)current_uid, dismissed_tag_uid) != 0);

        if (is_different_tag) {
            // Different tag detected - clear all suppression
            ESP_LOGI(TAG, "Different tag %s detected (was %s), clearing suppression", current_uid, dismissed_tag_uid);
            configured_tag_id[0] = '\0';
            dismissed_tag_uid[0] = '\0';
            popup_user_closed = false;
            is_suppressed = false;
        }

        if (!tag_popup) {
            // No popup open - check if we should open one
            if (!is_suppressed) {
                ESP_LOGI(TAG, "Opening popup for tag %s (dismissed=%s, configured=%s)",
                         current_uid, dismissed_tag_uid, configured_tag_id);
                create_tag_popup();
            }
            // else: suppressed, don't open
        } else {
            // Popup is open - check if we need to update for a different tag
            bool popup_is_different = (popup_tag_uid[0] != '\0') &&
                                      (strcmp((char*)current_uid, (char*)popup_tag_uid) != 0);
            if (popup_is_different) {
                ESP_LOGI(TAG, "Different tag %s (popup was %s), recreating popup", current_uid, popup_tag_uid);
                close_popup();
                dismissed_tag_uid[0] = '\0';
                popup_user_closed = false;
                create_tag_popup();
            }
        }
        // else: Same tag still present, popup already open - do nothing (weight updates elsewhere)
    } else {
        // Tag not present
        if (last_tag_present && !tag_present) {
            // Tag just lost - start the debounce timer
            tag_lost_time = lv_tick_get();
            ESP_LOGI(TAG, "Tag lost, starting debounce timer");
        } else if (tag_lost_time > 0) {
            // Tag still absent - check if debounce period has elapsed
            uint32_t elapsed = lv_tick_get() - tag_lost_time;
            if (elapsed >= TAG_REMOVAL_DEBOUNCE_MS) {
                // Tag has been gone long enough - clear suppression
                ESP_LOGI(TAG, "Tag gone for %dms, clearing suppression", elapsed);
                configured_tag_id[0] = '\0';
                dismissed_tag_uid[0] = '\0';
                popup_user_closed = false;
                memset(popup_tag_uid, 0, sizeof(popup_tag_uid));
                tag_lost_time = 0;  // Reset timer
            }
        }
    }

    last_tag_present = tag_present;

    // Note: Scale and NFC status are now shown in the global status bar (ui_status_bar.c)
}
