#!/bin/bash
# Update screens from EEZ Studio export
# Run this after exporting from EEZ Studio to ../eez/src/ui/
#
# This script:
# 1. Applies LVGL 9.x compatibility fixes to EEZ output
# 2. Creates symlinks from firmware to EEZ output
# 3. Creates symlinks from simulator to EEZ output
# 4. Preserves custom code (ui.c, ui_backend.c, etc.)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EEZ_DIR="$SCRIPT_DIR/../eez/src/ui"
FIRMWARE_UI_DIR="$SCRIPT_DIR/components/eez_ui"
SIMULATOR_UI_DIR="$SCRIPT_DIR/../lvgl-simulator-sdl/ui"

# Portable in-place sed (BSD vs GNU)
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

echo "==========================================="
echo "  EEZ UI Sync Script"
echo "==========================================="
echo ""

# Check if EEZ export exists
if [ ! -d "$EEZ_DIR" ]; then
    echo "ERROR: EEZ export not found at $EEZ_DIR"
    echo "Export from EEZ Studio first!"
    exit 1
fi

echo "EEZ source:  $EEZ_DIR"
echo "Firmware:    $FIRMWARE_UI_DIR"
echo "Simulator:   $SIMULATOR_UI_DIR"
echo ""

# ============================================================
# Step 1: Apply fixes to EEZ output (in-place)
# ============================================================
echo "Step 1: Applying LVGL 9.x and EEZ bug fixes..."

# Fix LVGL 9.x compatibility
sed_inplace 's/lv_img_dsc_t/lv_image_dsc_t/g' "$EEZ_DIR/images.h"

# Fix empty parameters in lv_image_set_pivot() - remove the calls entirely
sed_inplace 's/lv_image_set_pivot(obj, , );//g' "$EEZ_DIR/screens.c"

# Fix empty parameters in lv_image_set_rotation() - remove the calls entirely
sed_inplace 's/lv_image_set_rotation(obj, );//g' "$EEZ_DIR/screens.c"

# Fix undefined enum LV_LABEL_LONG_undefined -> LV_LABEL_LONG_WRAP
sed_inplace 's/LV_LABEL_LONG_undefined/LV_LABEL_LONG_WRAP/g' "$EEZ_DIR/screens.c"

# Fix duplicate 'settings' identifier - rename button to 'settings_main'
sed_inplace '/lv_obj_t \*encode_tag;/,/lv_obj_t \*catalog;/s/lv_obj_t \*settings;/lv_obj_t *settings_main;/' "$EEZ_DIR/screens.h"
sed_inplace '/objects.encode_tag = obj;/,/objects.catalog = obj;/{s/objects.settings = obj;/objects.settings_main = obj;/}' "$EEZ_DIR/screens.c"

echo "  - Applied fixes to EEZ source files"

# ============================================================
# Step 2: Create firmware symlinks
# ============================================================
echo ""
echo "Step 2: Creating firmware symlinks..."

# Files to symlink from EEZ (generated files)
EEZ_GENERATED_FILES=(
    "screens.c"
    "screens.h"
    "images.c"
    "images.h"
    "vars.h"
    "actions.h"
    "styles.c"
    "styles.h"
    "structs.h"
    "fonts.h"
)

# Create symlinks for EEZ generated files
for file in "${EEZ_GENERATED_FILES[@]}"; do
    target="$FIRMWARE_UI_DIR/$file"
    # Remove existing file/symlink
    rm -f "$target"
    # Create relative symlink (3 levels up from firmware/components/eez_ui/)
    ln -s "../../../eez/src/ui/$file" "$target"
done
echo "  - Linked core files: ${EEZ_GENERATED_FILES[*]}"

# Symlink all ui_image_*.c files
rm -f "$FIRMWARE_UI_DIR"/ui_image_*.c
for img in "$EEZ_DIR"/ui_image_*.c; do
    if [ -f "$img" ]; then
        basename=$(basename "$img")
        ln -s "../../../eez/src/ui/$basename" "$FIRMWARE_UI_DIR/$basename"
    fi
done
echo "  - Linked image files (ui_image_*.c)"

# ============================================================
# Step 3: Create simulator symlinks
# ============================================================
echo ""
echo "Step 3: Creating simulator symlinks..."

# Ensure simulator ui directory exists
mkdir -p "$SIMULATOR_UI_DIR"

# Symlink EEZ generated files to simulator
for file in "${EEZ_GENERATED_FILES[@]}"; do
    target="$SIMULATOR_UI_DIR/$file"
    rm -f "$target"
    ln -s "../../eez/src/ui/$file" "$target"
done
echo "  - Linked core files to simulator"

# Symlink image files to simulator
rm -f "$SIMULATOR_UI_DIR"/ui_image_*.c
for img in "$EEZ_DIR"/ui_image_*.c; do
    if [ -f "$img" ]; then
        basename=$(basename "$img")
        ln -s "../../eez/src/ui/$basename" "$SIMULATOR_UI_DIR/$basename"
    fi
done
echo "  - Linked image files to simulator"

# Symlink custom firmware code to simulator
CUSTOM_FILES=(
    "ui.c"
    "ui_backend.c"
    "ui_printer.c"
    "ui_wifi.c"
    "ui_settings.c"
    "ui_nvs.c"
    "ui_scale.c"
    "ui_update.c"
    "ui_status_bar.c"
    "ui_status_bar.h"
    "ui_internal.h"
)

for file in "${CUSTOM_FILES[@]}"; do
    target="$SIMULATOR_UI_DIR/$file"
    source="$FIRMWARE_UI_DIR/$file"
    if [ -f "$source" ]; then
        rm -f "$target"
        ln -s "../../firmware/components/eez_ui/$file" "$target"
    fi
done
echo "  - Linked custom code to simulator"

# ============================================================
# Summary
# ============================================================
echo ""
echo "==========================================="
echo "  Done!"
echo "==========================================="
echo ""
echo "Workflow:"
echo "  1. Make changes in EEZ Studio"
echo "  2. Build/Export in EEZ Studio"
echo "  3. Run this script: ./update_eez_screens.sh"
echo "  4. Build & test simulator:"
echo "     cd ../lvgl-simulator-sdl/build && cmake --build . -j"
echo "     ./simulator"
echo "  5. Build & flash firmware:"
echo "     cargo build --release"
echo ""
echo "Custom code preserved (not from EEZ):"
for file in "${CUSTOM_FILES[@]}"; do
    echo "  - $file"
done
echo ""
