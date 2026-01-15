/**
 * NFC Card UI - Main screen NFC/Scale card management
 * Shows a popup when NFC tag is detected
 */

#include "ui_nfc_card.h"
#include "screens.h"
#include "lvgl.h"
#include <stdio.h>
#include <string.h>

// External Rust FFI functions - NFC
extern bool nfc_is_initialized(void);
extern bool nfc_tag_present(void);

// Staging state (from backend) - USE THIS for popup, not raw tag detection
extern bool staging_is_active(void);
extern float staging_get_remaining(void);
extern void staging_clear(void);
extern uint8_t nfc_get_uid_hex(uint8_t *buf, uint8_t buf_len);

// Decoded tag data (Rust FFI on ESP32, mock on simulator)
extern const char* nfc_get_tag_vendor(void);
extern const char* nfc_get_tag_material(void);
extern const char* nfc_get_tag_material_subtype(void);
extern const char* nfc_get_tag_color_name(void);
extern uint32_t nfc_get_tag_color_rgba(void);
extern int nfc_get_tag_spool_weight(void);
extern const char* nfc_get_tag_type(void);
extern const char* nfc_get_tag_slicer_filament(void);
extern void nfc_update_tag_cache(const char *vendor, const char *material, const char *subtype,
                                 const char *color_name, uint32_t color_rgba);
extern void nfc_set_spool_just_added(const char *tag_id, const char *vendor, const char *material);

// Spool inventory functions (backend API)
extern bool spool_exists_by_tag(const char *tag_id);

// SpoolInfo struct (from backend_client.h)
typedef struct {
    char id[64];            // Spool UUID
    char tag_id[64];
    char brand[32];
    char material[32];
    char subtype[32];
    char color_name[32];
    uint32_t color_rgba;
    int label_weight;
    int weight_current;
    char slicer_filament[32];
    char tag_type[32];
    bool valid;
} SpoolInfo;

extern bool spool_get_by_tag(const char *tag_id, SpoolInfo *info);
extern bool spool_add_to_inventory(const char *tag_id, const char *vendor, const char *material,
                                    const char *subtype, const char *color_name, uint32_t color_rgba,
                                    int label_weight, int weight_current, const char *data_origin,
                                    const char *tag_type, const char *slicer_filament);

// Untagged spool info (for linking tags to existing spools)
typedef struct {
    char id[64];
    char brand[32];
    char material[32];
    char color_name[32];
    uint32_t color_rgba;
    int label_weight;
    int spool_number;
    bool valid;
} UntaggedSpoolInfo;

extern int spool_get_untagged_list(UntaggedSpoolInfo *spools, int max_count);
extern bool spool_link_tag(const char *spool_id, const char *tag_id, const char *tag_type);

// External Rust FFI functions - Scale
extern float scale_get_weight(void);
extern bool scale_is_initialized(void);
extern bool scale_is_stable(void);

// Screen navigation
extern enum ScreensEnum pendingScreen;

// Static state
static bool last_tag_present = false;
static bool popup_dismissed_for_current_tag = false;  // Prevents reopening after Add
static char last_tag_uid[32] = "";  // Track current tag UID to detect tag changes

// Link spool modal state
static lv_obj_t *link_spool_modal = NULL;
static UntaggedSpoolInfo untagged_spools_storage[32];
static int untagged_spools_count = 0;
static char pending_link_tag_id[64] = "";
static char pending_link_tag_type[32] = "";

// Forward declarations
static void close_popup(void);
static void close_link_spool_modal(void);
static void create_link_spool_modal(const char *tag_id, const char *tag_type);

// Popup elements
static lv_obj_t *tag_popup = NULL;
static lv_obj_t *popup_tag_label = NULL;
static lv_obj_t *popup_weight_label = NULL;
static lv_obj_t *popup_clear_btn_label = NULL;  // For updating countdown
static lv_timer_t *close_timer = NULL;

// Button click handlers
static void popup_close_handler(lv_event_t *e) {
    (void)e;
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

static void clear_staging_click_handler(lv_event_t *e) {
    (void)e;
    printf("[ui_nfc_card] Clear staging button clicked\n");
    // Clear staging via backend API
    staging_clear();
    // Close popup
    close_popup();
}

// Timer callback to close popup after showing feedback
static void close_popup_timer_cb(lv_timer_t *timer) {
    // Delete timer first
    lv_timer_delete(timer);
    close_timer = NULL;

    // Close popup if still open
    // Note: Don't set pendingScreen - popup is on top layer, main screen is still underneath
    if (tag_popup) {
        close_popup();
    }
}

static void add_spool_click_handler(lv_event_t *e) {
    const char *tag_id = (const char *)lv_event_get_user_data(e);
    if (!tag_id) return;

    // Get current tag data
    const char *vendor = nfc_get_tag_vendor();
    const char *material = nfc_get_tag_material();
    const char *subtype = nfc_get_tag_material_subtype();
    const char *color_name = nfc_get_tag_color_name();
    uint32_t color_rgba = nfc_get_tag_color_rgba();
    int label_weight = nfc_get_tag_spool_weight();
    const char *tag_type = nfc_get_tag_type();
    const char *slicer_filament = nfc_get_tag_slicer_filament();

    // Get current weight from scale
    int weight_current = 0;
    if (scale_is_initialized()) {
        weight_current = (int)scale_get_weight();
    }

    printf("[ui_nfc_card] Adding spool: tag=%s vendor=%s material=%s subtype=%s slicer=%s\n",
           tag_id, vendor, material, subtype ? subtype : "", slicer_filament ? slicer_filament : "");

    // Add to inventory
    bool success = spool_add_to_inventory(tag_id, vendor, material, subtype, color_name, color_rgba,
                                          label_weight, weight_current, "nfc_scan", tag_type, slicer_filament);

    if (success) {
        // Update tag cache so status bar shows the new spool info
        nfc_update_tag_cache(vendor, material, subtype, color_name, color_rgba);
        // Set "just added" flag for status bar message
        nfc_set_spool_just_added(tag_id, vendor, material);

        // Show success feedback - change button to green checkmark
        lv_obj_t *btn = lv_event_get_target(e);
        lv_obj_set_style_bg_color(btn, lv_color_hex(0x4CAF50), LV_PART_MAIN);
        lv_obj_clear_flag(btn, LV_OBJ_FLAG_CLICKABLE);

        // Update button label
        lv_obj_t *label = lv_obj_get_child(btn, 0);
        if (label) {
            lv_label_set_text(label, LV_SYMBOL_OK " Added!");
        }

        // Prevent popup from reopening while tag still present
        popup_dismissed_for_current_tag = true;

        // Close popup after 800ms so user sees the feedback
        close_timer = lv_timer_create(close_popup_timer_cb, 800, NULL);
    } else {
        printf("[ui_nfc_card] Failed to add spool to inventory\n");
    }
}

// Close popup if open
static void close_popup(void) {
    // Cancel any pending close timer
    if (close_timer) {
        lv_timer_delete(close_timer);
        close_timer = NULL;
    }

    if (tag_popup) {
        lv_obj_delete(tag_popup);
        tag_popup = NULL;
        popup_tag_label = NULL;
        popup_weight_label = NULL;
        popup_clear_btn_label = NULL;
    }
}

// =============================================================================
// Link Spool Modal - for linking tags to existing spools
// =============================================================================

static lv_timer_t *link_close_timer = NULL;

static void close_link_modal_timer_cb(lv_timer_t *timer) {
    lv_timer_delete(timer);
    link_close_timer = NULL;
    close_link_spool_modal();
}

static void close_link_spool_modal(void) {
    if (link_close_timer) {
        lv_timer_delete(link_close_timer);
        link_close_timer = NULL;
    }
    if (link_spool_modal) {
        lv_obj_delete(link_spool_modal);
        link_spool_modal = NULL;
    }
    pending_link_tag_id[0] = '\0';
    pending_link_tag_type[0] = '\0';
}

static void link_spool_close_handler(lv_event_t *e) {
    (void)e;
    close_link_spool_modal();
}

static void link_spool_item_click_handler(lv_event_t *e) {
    UntaggedSpoolInfo *spool = (UntaggedSpoolInfo *)lv_event_get_user_data(e);
    if (!spool || !spool->valid) return;

    printf("[ui_nfc_card] Linking tag %s to spool %s (#%d %s %s)\n",
           pending_link_tag_id, spool->id, spool->spool_number, spool->brand, spool->material);

    // Call backend to link tag
    bool success = spool_link_tag(spool->id, pending_link_tag_id, pending_link_tag_type);

    if (success) {
        // Update tag cache so status bar shows the linked spool info
        nfc_update_tag_cache(spool->brand, spool->material, NULL, spool->color_name, spool->color_rgba);
        // Set "just added" flag for status bar message
        nfc_set_spool_just_added(pending_link_tag_id, spool->brand, spool->material);

        // Show success feedback on the button
        lv_obj_t *btn = lv_event_get_target(e);
        lv_obj_set_style_bg_color(btn, lv_color_hex(0x4CAF50), LV_PART_MAIN);
        lv_obj_clear_flag(btn, LV_OBJ_FLAG_CLICKABLE);

        // Update the info label to show success
        lv_obj_t *info_label = lv_obj_get_child(btn, 1);  // Second child is info label
        if (info_label) {
            lv_label_set_text(info_label, LV_SYMBOL_OK " Linked!");
        }

        // Close modal after delay
        link_close_timer = lv_timer_create(close_link_modal_timer_cb, 800, NULL);
    } else {
        // Show error - red flash on button
        lv_obj_t *btn = lv_event_get_target(e);
        lv_obj_set_style_bg_color(btn, lv_color_hex(0xFF5555), LV_PART_MAIN);
        printf("[ui_nfc_card] Failed to link tag\n");
    }
}

static void link_spool_click_handler(lv_event_t *e) {
    const char *tag_id = (const char *)lv_event_get_user_data(e);
    if (!tag_id) return;

    // Store tag info for linking
    strncpy(pending_link_tag_id, tag_id, sizeof(pending_link_tag_id) - 1);
    const char *tag_type = nfc_get_tag_type();
    if (tag_type) {
        strncpy(pending_link_tag_type, tag_type, sizeof(pending_link_tag_type) - 1);
    }

    // Close the tag popup first
    close_popup();

    // Open the link spool selection modal
    create_link_spool_modal(tag_id, pending_link_tag_type);
}

static void create_link_spool_modal(const char *tag_id, const char *tag_type) {
    (void)tag_id;
    (void)tag_type;

    if (link_spool_modal) return;  // Already open

    // Fetch untagged spools from backend
    untagged_spools_count = spool_get_untagged_list(untagged_spools_storage, 32);
    printf("[ui_nfc_card] Creating link spool modal with %d untagged spools\n", untagged_spools_count);

    // Create modal on top layer
    link_spool_modal = lv_obj_create(lv_layer_top());
    lv_obj_set_size(link_spool_modal, 800, 480);
    lv_obj_set_pos(link_spool_modal, 0, 0);
    lv_obj_set_style_bg_color(link_spool_modal, lv_color_hex(0x000000), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(link_spool_modal, 180, LV_PART_MAIN);
    lv_obj_set_style_border_width(link_spool_modal, 0, LV_PART_MAIN);
    lv_obj_clear_flag(link_spool_modal, LV_OBJ_FLAG_SCROLLABLE);

    // Click on background closes modal
    lv_obj_add_event_cb(link_spool_modal, link_spool_close_handler, LV_EVENT_CLICKED, NULL);

    // Create card container
    int card_height = (untagged_spools_count == 0) ? 200 : 380;
    lv_obj_t *card = lv_obj_create(link_spool_modal);
    lv_obj_set_size(card, 500, card_height);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(0x1E88E5), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 15, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    // Absorb clicks on card
    lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);

    // Title
    lv_obj_t *title = lv_label_create(card);
    lv_label_set_text(title, "Link Tag to Spool");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x1E88E5), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

    if (untagged_spools_count == 0) {
        // No untagged spools - show message
        lv_obj_t *msg = lv_label_create(card);
        lv_label_set_text(msg, "No spools without tags found.\n\n"
                              "Create spools in the web UI first,\n"
                              "then link them to NFC tags here.");
        lv_obj_set_style_text_color(msg, lv_color_hex(0xaaaaaa), LV_PART_MAIN);
        lv_obj_set_style_text_align(msg, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
        lv_obj_align(msg, LV_ALIGN_CENTER, 0, 0);
    } else {
        // Subtitle
        lv_obj_t *subtitle = lv_label_create(card);
        lv_label_set_text(subtitle, "Select spool to link with tag");
        lv_obj_set_style_text_font(subtitle, &lv_font_montserrat_12, LV_PART_MAIN);
        lv_obj_set_style_text_color(subtitle, lv_color_hex(0x888888), LV_PART_MAIN);
        lv_obj_align(subtitle, LV_ALIGN_TOP_MID, 0, 28);

        // Scrollable list container
        lv_obj_t *list_container = lv_obj_create(card);
        lv_obj_set_size(list_container, 460, 250);
        lv_obj_align(list_container, LV_ALIGN_TOP_MID, 0, 50);
        lv_obj_set_style_bg_opa(list_container, 0, LV_PART_MAIN);
        lv_obj_set_style_border_width(list_container, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(list_container, 5, LV_PART_MAIN);
        lv_obj_set_flex_flow(list_container, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_row(list_container, 8, LV_PART_MAIN);
        lv_obj_add_flag(list_container, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_clear_flag(list_container, LV_OBJ_FLAG_SCROLL_ELASTIC);

        // Create spool items
        for (int i = 0; i < untagged_spools_count; i++) {
            UntaggedSpoolInfo *spool = &untagged_spools_storage[i];

            lv_obj_t *btn = lv_btn_create(list_container);
            lv_obj_set_size(btn, 440, 50);
            lv_obj_set_style_bg_color(btn, lv_color_hex(0x2d2d2d), LV_PART_MAIN);
            lv_obj_set_style_bg_color(btn, lv_color_hex(0x3d3d3d), LV_PART_MAIN | LV_STATE_PRESSED);
            lv_obj_set_style_radius(btn, 8, LV_PART_MAIN);

            // Store spool pointer for callback
            lv_obj_add_event_cb(btn, link_spool_item_click_handler, LV_EVENT_CLICKED, spool);

            // Color indicator (small circle)
            lv_obj_t *color_dot = lv_obj_create(btn);
            lv_obj_set_size(color_dot, 24, 24);
            lv_obj_align(color_dot, LV_ALIGN_LEFT_MID, 5, 0);
            lv_obj_set_style_radius(color_dot, LV_RADIUS_CIRCLE, LV_PART_MAIN);
            lv_obj_set_style_border_width(color_dot, 0, LV_PART_MAIN);
            lv_obj_set_style_pad_all(color_dot, 0, LV_PART_MAIN);
            lv_obj_set_scrollbar_mode(color_dot, LV_SCROLLBAR_MODE_OFF);
            lv_obj_clear_flag(color_dot, LV_OBJ_FLAG_SCROLLABLE);
            uint8_t r = (spool->color_rgba >> 24) & 0xFF;
            uint8_t g = (spool->color_rgba >> 16) & 0xFF;
            uint8_t b = (spool->color_rgba >> 8) & 0xFF;
            lv_obj_set_style_bg_color(color_dot, lv_color_make(r, g, b), LV_PART_MAIN);
            lv_obj_set_style_bg_opa(color_dot, LV_OPA_COVER, LV_PART_MAIN);

            // Spool info label
            lv_obj_t *info_label = lv_label_create(btn);
            char info_text[128];
            snprintf(info_text, sizeof(info_text), "#%d  %s %s",
                     spool->spool_number,
                     spool->brand[0] ? spool->brand : "Unknown",
                     spool->material[0] ? spool->material : "");
            lv_label_set_text(info_label, info_text);
            lv_obj_set_style_text_color(info_label, lv_color_hex(0xffffff), LV_PART_MAIN);
            lv_obj_align(info_label, LV_ALIGN_LEFT_MID, 40, -8);

            // Color name and weight
            lv_obj_t *detail_label = lv_label_create(btn);
            char detail_text[64];
            snprintf(detail_text, sizeof(detail_text), "%s - %dg",
                     spool->color_name[0] ? spool->color_name : "Unknown",
                     spool->label_weight);
            lv_label_set_text(detail_label, detail_text);
            lv_obj_set_style_text_font(detail_label, &lv_font_montserrat_12, LV_PART_MAIN);
            lv_obj_set_style_text_color(detail_label, lv_color_hex(0x888888), LV_PART_MAIN);
            lv_obj_align(detail_label, LV_ALIGN_LEFT_MID, 40, 10);
        }
    }

    // Close button at the bottom
    lv_obj_t *close_btn = lv_btn_create(card);
    lv_obj_set_size(close_btn, 120, 40);
    lv_obj_align(close_btn, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_bg_color(close_btn, lv_color_hex(0x444444), LV_PART_MAIN);
    lv_obj_set_style_radius(close_btn, 8, LV_PART_MAIN);
    lv_obj_add_event_cb(close_btn, link_spool_close_handler, LV_EVENT_CLICKED, NULL);

    lv_obj_t *close_label = lv_label_create(close_btn);
    lv_label_set_text(close_label, "Cancel");
    lv_obj_set_style_text_color(close_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(close_label);
}

// Create the tag detected popup
static void create_tag_popup(void) {
    if (tag_popup) return;  // Already open

    // Get tag UID
    uint8_t uid_str[32];
    nfc_get_uid_hex(uid_str, sizeof(uid_str));

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
    lv_obj_set_size(card, 450, 300);
    lv_obj_center(card);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1a1a1a), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(card, 255, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(0x4CAF50), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 20, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    // Prevent clicks on card from closing popup
    lv_obj_add_flag(card, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(card, NULL, LV_EVENT_CLICKED, NULL);  // Absorb click

    // Title
    lv_obj_t *title = lv_label_create(card);
    lv_label_set_text(title, "NFC Tag Detected");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x4CAF50), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 0);

    // Check if tag is already in inventory
    SpoolInfo inventory_spool = {0};
    bool tag_in_inventory = spool_get_by_tag((const char*)uid_str, &inventory_spool);

    // Use inventory data if available, otherwise use NFC tag data
    const char *vendor;
    const char *material;
    const char *color_name;
    uint32_t color_rgba;

    if (tag_in_inventory && inventory_spool.valid) {
        vendor = inventory_spool.brand;
        material = inventory_spool.material;
        color_name = inventory_spool.color_name;
        color_rgba = inventory_spool.color_rgba;
        printf("[ui_nfc_card] Using inventory data: %s %s %s, color_rgba=0x%08X\n",
               vendor, material, color_name, color_rgba);
    } else {
        vendor = nfc_get_tag_vendor();
        material = nfc_get_tag_material();
        color_name = nfc_get_tag_color_name();
        color_rgba = nfc_get_tag_color_rgba();
        printf("[ui_nfc_card] Using NFC tag data: %s %s %s, color_rgba=0x%08X\n",
               vendor, material, color_name, color_rgba);
    }

    // Container for spool + details (centered)
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

    // Spool image container (for layered images)
    lv_obj_t *spool_container = lv_obj_create(content_container);
    lv_obj_set_size(spool_container, 50, 60);
    lv_obj_set_style_bg_opa(spool_container, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(spool_container, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(spool_container, 0, LV_PART_MAIN);
    lv_obj_clear_flag(spool_container, LV_OBJ_FLAG_SCROLLABLE);

    // Spool image with colored inlet (matching scan_result screen style)
    extern const lv_image_dsc_t img_spool_clean;
    extern const lv_image_dsc_t img_spool_fill;

    // Outline first (underneath)
    lv_obj_t *spool_outline = lv_image_create(spool_container);
    lv_image_set_src(spool_outline, &img_spool_clean);
    lv_image_set_scale(spool_outline, 300);
    lv_obj_set_pos(spool_outline, 0, 0);

    // Color fill on top
    lv_obj_t *spool_fill = lv_image_create(spool_container);
    lv_image_set_src(spool_fill, &img_spool_fill);
    lv_image_set_scale(spool_fill, 300);
    lv_obj_set_pos(spool_fill, 0, 0);

    // Color the inlet with filament color
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

    // Spool details container (for label/value pairs with different colors)
    lv_obj_t *details_container = lv_obj_create(content_container);
    lv_obj_set_size(details_container, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(details_container, 0, 0);
    lv_obj_set_style_border_width(details_container, 0, 0);
    lv_obj_set_style_pad_all(details_container, 0, 0);
    lv_obj_clear_flag(details_container, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(details_container, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(details_container, 4, 0);

    // Helper to create label/value row
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
        snprintf(weight_str, sizeof(weight_str), "%dg", (int)weight);
    } else {
        snprintf(weight_str, sizeof(weight_str), "N/A");
    }

    CREATE_DETAIL_ROW("Tag:", (const char*)uid_str);
    CREATE_DETAIL_ROW("Vendor:", (vendor && vendor[0]) ? vendor : "Unknown");
    CREATE_DETAIL_ROW("Material:", (material && material[0]) ? material : "Unknown");
    CREATE_DETAIL_ROW("Color:", (color_name && color_name[0]) ? color_name : "Unknown");
    CREATE_DETAIL_ROW("Weight:", weight_str);

    #undef CREATE_DETAIL_ROW

    // Store references (no longer used for dynamic updates)
    popup_tag_label = NULL;
    popup_weight_label = NULL;
    static char stored_tag_id[32];
    strncpy(stored_tag_id, (const char*)uid_str, sizeof(stored_tag_id) - 1);

    // Check if this is an unknown tag (needs manual configuration)
    bool is_unknown_tag = (vendor && strcmp(vendor, "Unknown") == 0);

    // Show hint for unknown tags (positioned above 2x2 button grid)
    if (is_unknown_tag && !tag_in_inventory) {
        lv_obj_t *hint_label = lv_label_create(card);
        lv_label_set_text(hint_label, LV_SYMBOL_WARNING " Add to inventory, then edit details in web UI");
        lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_12, LV_PART_MAIN);
        lv_obj_set_style_text_color(hint_label, lv_color_hex(0xFFAA00), LV_PART_MAIN);
        lv_obj_align(hint_label, LV_ALIGN_BOTTOM_MID, 0, -105);  // Adjusted for 2x2 grid
    }

    // Buttons container - always 2x2 grid layout
    lv_obj_t *btn_container = lv_obj_create(card);
    lv_obj_set_size(btn_container, LV_PCT(100), 100);  // 2 rows
    lv_obj_align(btn_container, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_bg_opa(btn_container, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(btn_container, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(btn_container, 0, LV_PART_MAIN);
    lv_obj_clear_flag(btn_container, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(btn_container, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_flex_align(btn_container, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(btn_container, 8, LV_PART_MAIN);

    int btn_width = 180;

    // "Add Spool" button (or "In Inventory" if already known)
    lv_obj_t *btn_add = lv_btn_create(btn_container);
    lv_obj_set_size(btn_add, btn_width, 42);
    lv_obj_set_style_radius(btn_add, 8, LV_PART_MAIN);

    if (tag_in_inventory) {
        // Disabled - already in inventory
        lv_obj_set_style_bg_color(btn_add, lv_color_hex(0x444444), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(btn_add, 128, LV_PART_MAIN);
        lv_obj_clear_flag(btn_add, LV_OBJ_FLAG_CLICKABLE);
    } else {
        // Enabled
        lv_obj_set_style_bg_color(btn_add, lv_color_hex(0x2D5A27), LV_PART_MAIN);
        lv_obj_add_event_cb(btn_add, add_spool_click_handler, LV_EVENT_CLICKED, stored_tag_id);
    }

    lv_obj_t *add_label = lv_label_create(btn_add);
    lv_label_set_text(add_label, tag_in_inventory ? "In Inventory" : "Add Spool");
    lv_obj_set_style_text_font(add_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(add_label, tag_in_inventory ? lv_color_hex(0x888888) : lv_color_hex(0xFFFFFF), LV_PART_MAIN);
    lv_obj_center(add_label);

    // "Link to Spool" button - disabled if already in inventory (tag already linked)
    lv_obj_t *btn_link = lv_btn_create(btn_container);
    lv_obj_set_size(btn_link, btn_width, 42);
    lv_obj_set_style_radius(btn_link, 8, LV_PART_MAIN);

    if (tag_in_inventory) {
        // Disabled - tag already linked to a spool
        lv_obj_set_style_bg_color(btn_link, lv_color_hex(0x444444), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(btn_link, 128, LV_PART_MAIN);
        lv_obj_clear_flag(btn_link, LV_OBJ_FLAG_CLICKABLE);
    } else {
        // Enabled
        lv_obj_set_style_bg_color(btn_link, lv_color_hex(0x1976D2), LV_PART_MAIN);
        lv_obj_add_event_cb(btn_link, link_spool_click_handler, LV_EVENT_CLICKED, stored_tag_id);
    }

    lv_obj_t *link_label = lv_label_create(btn_link);
    lv_label_set_text(link_label, tag_in_inventory ? "Tag Linked" : "Link to Spool");
    lv_obj_set_style_text_font(link_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(link_label, tag_in_inventory ? lv_color_hex(0x888888) : lv_color_hex(0xFFFFFF), LV_PART_MAIN);
    lv_obj_center(link_label);

    // "Configure AMS" button - only enabled if tag is in inventory
    lv_obj_t *btn_ams = lv_btn_create(btn_container);
    lv_obj_set_size(btn_ams, btn_width, 42);
    lv_obj_set_style_radius(btn_ams, 8, LV_PART_MAIN);

    if (tag_in_inventory) {
        // Enabled - tag is in inventory
        lv_obj_set_style_bg_color(btn_ams, lv_color_hex(0x1E88E5), LV_PART_MAIN);
        lv_obj_add_event_cb(btn_ams, configure_ams_click_handler, LV_EVENT_CLICKED, NULL);
    } else {
        // Disabled - unknown tag, can't configure AMS without spool in inventory
        lv_obj_set_style_bg_color(btn_ams, lv_color_hex(0x444444), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(btn_ams, 128, LV_PART_MAIN);
        lv_obj_clear_flag(btn_ams, LV_OBJ_FLAG_CLICKABLE);
    }

    lv_obj_t *ams_label = lv_label_create(btn_ams);
    lv_label_set_text(ams_label, "Config AMS");
    lv_obj_set_style_text_font(ams_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(ams_label, tag_in_inventory ? lv_color_hex(0xFFFFFF) : lv_color_hex(0x888888), LV_PART_MAIN);
    lv_obj_center(ams_label);

    // "Clear" button - clears staging and closes popup (shows countdown)
    lv_obj_t *btn_clear = lv_btn_create(btn_container);
    lv_obj_set_size(btn_clear, btn_width, 42);
    lv_obj_set_style_bg_color(btn_clear, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_set_style_radius(btn_clear, 8, LV_PART_MAIN);
    lv_obj_add_flag(btn_clear, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(btn_clear, clear_staging_click_handler, LV_EVENT_CLICKED, NULL);

    popup_clear_btn_label = lv_label_create(btn_clear);
    char clear_text[32];
    snprintf(clear_text, sizeof(clear_text), "Clear (%.0fs)", staging_get_remaining());
    lv_label_set_text(popup_clear_btn_label, clear_text);
    lv_obj_set_style_text_font(popup_clear_btn_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_center(popup_clear_btn_label);
}

// Update weight display in popup if open
static void update_popup_weight(void) {
    if (!popup_weight_label) return;

    float weight = scale_get_weight();
    bool scale_ok = scale_is_initialized();

    char weight_text[64];
    if (scale_ok) {
        snprintf(weight_text, sizeof(weight_text), "Weight: %.1fg", weight);
    } else {
        snprintf(weight_text, sizeof(weight_text), "Weight: N/A (scale not ready)");
    }
    lv_label_set_text(popup_weight_label, weight_text);
}

void ui_nfc_card_init(void) {
    last_tag_present = false;
    close_popup();
}

void ui_nfc_card_cleanup(void) {
    close_popup();
    close_link_spool_modal();
    last_tag_present = false;
    last_tag_uid[0] = '\0';
}

void ui_nfc_card_update(void) {
    if (!nfc_is_initialized()) return;

    // Use STAGING state for popup control, NOT raw tag detection
    // Staging is more stable - persists for 300s even if NFC reads are flaky
    bool staging_active = staging_is_active();

    // Get current tag UID to detect tag changes while staging remains active
    char current_uid[32] = "";
    if (staging_active) {
        nfc_get_uid_hex((uint8_t*)current_uid, sizeof(current_uid));
    }

    // Check if tag UID changed (new tag placed while popup open)
    bool tag_changed = staging_active && last_tag_present &&
                       current_uid[0] && last_tag_uid[0] &&
                       strcmp(current_uid, last_tag_uid) != 0;

    if (tag_changed) {
        printf("[ui_nfc_card] Tag UID changed: %s -> %s, recreating popup\n",
               last_tag_uid, current_uid);
        // Close old popup and show new one with updated data
        close_popup();
        popup_dismissed_for_current_tag = false;
        strncpy(last_tag_uid, current_uid, sizeof(last_tag_uid) - 1);
        create_tag_popup();
    }
    // Staging state changed
    else if (staging_active != last_tag_present) {
        printf("[ui_nfc_card] Staging changed: %d -> %d (remaining=%.1fs)\n",
               last_tag_present, staging_active, staging_get_remaining());
        last_tag_present = staging_active;

        if (staging_active) {
            // Tag staged - show popup (unless dismissed for this tag)
            strncpy(last_tag_uid, current_uid, sizeof(last_tag_uid) - 1);
            if (!popup_dismissed_for_current_tag) {
                printf("[ui_nfc_card] Creating popup (staging active)\n");
                create_tag_popup();
            }
        } else {
            // Staging expired - close popup and reset dismissed flag
            printf("[ui_nfc_card] Closing popup (staging expired)\n");
            close_popup();
            popup_dismissed_for_current_tag = false;
            last_tag_uid[0] = '\0';
        }
    } else if (staging_active && tag_popup) {
        // Staging still active - update weight and countdown in popup
        update_popup_weight();

        // Update clear button countdown
        if (popup_clear_btn_label) {
            char clear_text[32];
            snprintf(clear_text, sizeof(clear_text), "Clear (%.0fs)", staging_get_remaining());
            lv_label_set_text(popup_clear_btn_label, clear_text);
        }
    }

    // Always update scale status label on main screen (shows current weight)
    if (objects.main_screen_nfc_scale_scale_label) {
        if (scale_is_initialized()) {
            float weight = scale_get_weight();
            char weight_str[16];
            snprintf(weight_str, sizeof(weight_str), "%.1fg", weight);
            lv_label_set_text(objects.main_screen_nfc_scale_scale_label, weight_str);
            lv_obj_set_style_text_color(objects.main_screen_nfc_scale_scale_label,
                lv_color_hex(0xFF00FF00), LV_PART_MAIN);
        } else {
            lv_label_set_text(objects.main_screen_nfc_scale_scale_label, "N/A");
            lv_obj_set_style_text_color(objects.main_screen_nfc_scale_scale_label,
                lv_color_hex(0xFFFF6600), LV_PART_MAIN);
        }
    }

    // NFC status always shows "Ready"
    if (objects.main_screen_nfc_scale_nfc_label) {
        lv_label_set_text(objects.main_screen_nfc_scale_nfc_label, "Ready");
    }
}

// Show popup externally (e.g., from status bar click)
void ui_nfc_card_show_popup(void) {
    bool staging = staging_is_active();
    printf("[ui_nfc_card] show_popup called: staging=%d, tag_popup=%p, dismissed=%d\n",
           staging, (void*)tag_popup, popup_dismissed_for_current_tag);

    if (staging && !tag_popup) {
        printf("[ui_nfc_card] Showing popup from external request\n");
        popup_dismissed_for_current_tag = false;
        create_tag_popup();
    }
}

// Check if popup is currently shown
bool ui_nfc_card_popup_visible(void) {
    return tag_popup != NULL;
}
