#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef void (*phi_terminal_callback)(const char *id, const char *event);
bool phi_terminal_init(phi_terminal_callback callback, const char *resources);
bool phi_terminal_create(void *window, const char *id, const char *command,
                         const char *cwd, const char *environment, bool dark,
                         const char *theme_config);
void phi_terminal_present(const char *id, double x, double y, double width,
                          double height, bool visible, bool focus, bool dark,
                          const char *theme_config, const char *overlay_config);
void phi_terminal_set_visible(const char *ids_json);
void phi_terminal_tick(void);
void phi_terminal_hide(void);
void phi_terminal_close(const char *id);
bool phi_terminal_exited(const char *id);
void phi_terminal_shutdown(void);
bool phi_terminal_confirm_quit(void);
