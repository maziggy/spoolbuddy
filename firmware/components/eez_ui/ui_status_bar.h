/**
 * @file ui_status_bar.h
 * @brief Global status bar for main screen and AMS overview
 *
 * Displays:
 * - Left: Backend connection status (green/red dot)
 * - Center: Active tray color badge + material type
 * - Right: NFC status + Scale weight
 */

#ifndef UI_STATUS_BAR_H
#define UI_STATUS_BAR_H

#include <stdbool.h>

/**
 * Initialize status bar elements on a screen's bottom bar.
 * Call after screen creation.
 *
 * @param is_main_screen true for main_screen, false for ams_overview
 */
void ui_status_bar_init(bool is_main_screen);

/**
 * Update status bar with current state.
 * Call periodically from ui_tick.
 */
void ui_status_bar_update(void);

/**
 * Cleanup status bar elements.
 * Call before screen deletion.
 */
void ui_status_bar_cleanup(void);

#endif /* UI_STATUS_BAR_H */
