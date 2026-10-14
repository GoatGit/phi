// Native host for Ghostty 1.2.3. All entry points and AppKit work run on the
// main thread. Ghostty owns each PTY; React owns only workspace chrome.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import "ghostty.h"
#import "terminal.h"

static ghostty_app_t core;
static phi_terminal_callback emit;
static NSMutableDictionary *views;
static char background[] = "--background=ffffff";
static char foreground[] = "--foreground=18181b";
static char *arguments[] = {"phi-terminal", "--font-family=Menlo", "--font-size=13",
  background, foreground, "--cursor-color=c2410c", "--shell-integration=none",
  "--window-padding-x=12", "--window-padding-y=10", "--clipboard-read=ask",
  "--clipboard-write=ask", "--quit-after-last-window-closed=false"};
static bool darkTheme;
static NSString *activeThemeConfig;
static IMP originalTerminate;
static NSApplicationTerminateReply guardedTerminate(id delegate, SEL selector, NSApplication *application) {
  if (!phi_terminal_confirm_quit()) return NSTerminateCancel;
  return originalTerminate ? ((NSApplicationTerminateReply (*)(id, SEL, NSApplication *))originalTerminate)(delegate, selector, application) : NSTerminateNow;
}
extern bool phi_ghostty_config_load(ghostty_config_t, const char *);
static ghostty_config_t hostConfig(bool dark, NSString *colors) {
  ghostty_config_t config = ghostty_config_new();
  NSString *text = [NSString stringWithFormat:@"font-family = Menlo\nfont-size = 13\nbackground = %@\nforeground = %@\ncursor-color = c2410c\nshell-integration = none\nwindow-padding-x = 12\nwindow-padding-y = 10\nclipboard-read = ask\nclipboard-write = ask\nquit-after-last-window-closed = false\n", dark ? @"1c1c1e" : @"ffffff", dark ? @"e4e4e7" : @"18181b"];
  phi_ghostty_config_load(config, text.UTF8String);
  if (colors.length) phi_ghostty_config_load(config, colors.UTF8String);
  ghostty_config_finalize(config);
  return config;
}

@interface PHITerminalView : NSView <NSTextInputClient>
@property(nonatomic) ghostty_surface_t surface;
@property(nonatomic, copy) NSString *sessionId;
@property(nonatomic, strong) NSMutableAttributedString *marked;
@property(nonatomic, strong) NSMutableArray<NSString *> *keyText;
@property(nonatomic, strong) NSTrackingArea *tracking;
@property(nonatomic) BOOL reportedExit;
@property(nonatomic) BOOL inputBlocked;
@property(nonatomic) BOOL restoreFocusOnActivate;
@property(nonatomic, strong) NSArray<NSValue *> *overlayRects;
@property(nonatomic, strong) CALayer *dimmingLayer;
- (void)resizeSurface;
- (void)updateOverlay:(NSDictionary *)overlay;
@end

static void report(PHITerminalView *view, const char *event) {
  if (emit) emit(view ? view.sessionId.UTF8String : "", event);
}
static void tick(void) {
  if (!core) return;
  ghostty_app_tick(core);
  for (PHITerminalView *view in [views.allValues copy]) {
    if (view.surface && !view.reportedExit && ghostty_surface_process_exited(view.surface)) {
      view.reportedExit = YES;
      report(view, "exited");
    }
  }
}
static void wakeup(void *unused) {
  (void)unused;
  dispatch_async(dispatch_get_main_queue(), ^{ tick(); });
}
static bool action(ghostty_app_t app, ghostty_target_s target, ghostty_action_s value) {
  (void)app;
  PHITerminalView *view = target.tag == GHOSTTY_TARGET_SURFACE
    ? (__bridge PHITerminalView *)ghostty_surface_userdata(target.target.surface) : nil;
  switch (value.tag) {
    case GHOSTTY_ACTION_NEW_TAB: report(view, "new"); return true;
    case GHOSTTY_ACTION_CLOSE_TAB: report(view, "close"); return true;
    case GHOSTTY_ACTION_QUIT: report(view, "quit"); return true;
    case GHOSTTY_ACTION_RING_BELL: NSBeep(); return true;
    // Terminal-controlled titles/URLs/notifications never acquire host privileges.
    case GHOSTTY_ACTION_SET_TITLE: return true;
    case GHOSTTY_ACTION_RENDER: if (view.surface) ghostty_surface_draw(view.surface); return true;
    default: return false;
  }
}
static void readClipboard(void *userdata, ghostty_clipboard_e location, void *request) {
  PHITerminalView *view = (__bridge PHITerminalView *)userdata;
  if (location != GHOSTTY_CLIPBOARD_STANDARD || !view.surface) return;
  NSString *text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @"";
  ghostty_surface_complete_clipboard_request(view.surface, text.UTF8String, request, false);
}
static BOOL confirm(NSString *title, NSString *detail, NSString *accept) {
  NSAlert *alert = [NSAlert new];
  alert.messageText = title; alert.informativeText = detail;
  [alert addButtonWithTitle:NSLocalizedString(@"Cancel", nil)];
  [alert addButtonWithTitle:accept];
  return [alert runModal] == NSAlertSecondButtonReturn;
}
static void confirmClipboard(void *userdata, const char *text, void *request,
                             ghostty_clipboard_request_e kind) {
  PHITerminalView *view = (__bridge PHITerminalView *)userdata;
  if (!view.surface) return;
  NSString *detail = kind == GHOSTTY_CLIPBOARD_REQUEST_PASTE
    ? NSLocalizedString(@"This paste contains commands or multiple lines.", nil)
    : NSLocalizedString(@"The terminal application requested access to the system clipboard.", nil);
  BOOL allowed = confirm(NSLocalizedString(@"Allow clipboard access?", nil), detail,
                        NSLocalizedString(@"Allow", nil));
  if (view.surface) ghostty_surface_complete_clipboard_request(view.surface, allowed ? text : "", request, true);
}
static void writeClipboard(void *userdata, const char *text, ghostty_clipboard_e location, bool ask) {
  (void)userdata;
  if (location != GHOSTTY_CLIPBOARD_STANDARD) return;
  if (ask && !confirm(NSLocalizedString(@"Replace clipboard contents?", nil),
      NSLocalizedString(@"The terminal application wants to write to the clipboard.", nil),
      NSLocalizedString(@"Allow", nil))) return;
  [NSPasteboard.generalPasteboard clearContents];
  [NSPasteboard.generalPasteboard setString:[NSString stringWithUTF8String:text] ?: @""
                                  forType:NSPasteboardTypeString];
}
static void closeSurface(void *userdata, bool alive) {
  PHITerminalView *view = (__bridge PHITerminalView *)userdata;
  // Never free a surface during a libghostty callback.
  if (!alive) { view.reportedExit = YES; report(view, "exited"); }
  else report(view, "close");
}
static ghostty_input_mods_e modifiers(NSEventModifierFlags flags) {
  unsigned value = 0;
  if (flags & NSEventModifierFlagShift) value |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) value |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) value |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) value |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) value |= GHOSTTY_MODS_CAPS;
  return (ghostty_input_mods_e)value;
}

@implementation PHITerminalView
- (instancetype)initWithFrame:(NSRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.marked = [[NSMutableAttributedString alloc] initWithString:@""];
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewNotSizable;
  }
  return self;
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return !self.hidden && !self.inputBlocked; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (BOOL)becomeFirstResponder {
  if (self.hidden || self.inputBlocked) return NO;
  if (_surface) { ghostty_app_set_focus(core, NSApp.active); ghostty_surface_set_focus(_surface, true); }
  return YES;
}
- (BOOL)resignFirstResponder { if (_surface) ghostty_surface_set_focus(_surface, false); return YES; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self resizeSurface]; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self resizeSurface]; }
- (NSView *)hitTest:(NSPoint)point {
  // Menus own outside clicks too, so WebView can dismiss them. A tooltip only
  // passes through its own rectangle and never disables the whole terminal.
  if (self.inputBlocked) return nil;
  NSPoint local = [self convertPoint:point fromView:self.superview];
  for (NSValue *rect in self.overlayRects) if (NSPointInRect(local, rect.rectValue)) return nil;
  return [super hitTest:point];
}
- (void)updateOverlay:(NSDictionary *)overlay {
  self.inputBlocked = [overlay[@"blocked"] boolValue];
  NSMutableArray<NSValue *> *holes = [NSMutableArray new];
  NSMutableArray<NSValue *> *pieces = [NSMutableArray arrayWithObject:[NSValue valueWithRect:self.bounds]];
  for (NSDictionary *item in overlay[@"rects"]) {
    NSRect hole = NSIntersectionRect(self.bounds, NSMakeRect([item[@"x"] doubleValue], [item[@"y"] doubleValue],
      [item[@"width"] doubleValue], [item[@"height"] doubleValue]));
    if (NSIsEmptyRect(hole)) continue;
    [holes addObject:[NSValue valueWithRect:hole]];
    // Rectangle subtraction forms a union of holes even when a menu and its
    // submenu overlap. An even-odd mask would accidentally fill their overlap.
    NSMutableArray<NSValue *> *remaining = [NSMutableArray new];
    for (NSValue *value in pieces) {
      NSRect rect = value.rectValue, cut = NSIntersectionRect(rect, hole);
      if (NSIsEmptyRect(cut)) { [remaining addObject:value]; continue; }
      NSRect parts[] = {
        NSMakeRect(NSMinX(rect), NSMinY(rect), NSWidth(rect), NSMinY(cut) - NSMinY(rect)),
        NSMakeRect(NSMinX(rect), NSMaxY(cut), NSWidth(rect), NSMaxY(rect) - NSMaxY(cut)),
        NSMakeRect(NSMinX(rect), NSMinY(cut), NSMinX(cut) - NSMinX(rect), NSHeight(cut)),
        NSMakeRect(NSMaxX(cut), NSMinY(cut), NSMaxX(rect) - NSMaxX(cut), NSHeight(cut)),
      };
      for (NSUInteger i = 0; i < 4; i++) if (!NSIsEmptyRect(parts[i])) [remaining addObject:[NSValue valueWithRect:parts[i]]];
    }
    pieces = remaining;
  }
  self.overlayRects = holes;
  [CATransaction begin]; [CATransaction setDisableActions:YES];
  if (holes.count) {
    CGMutablePathRef path = CGPathCreateMutable();
    for (NSValue *value in pieces) CGPathAddRect(path, NULL, NSRectToCGRect(value.rectValue));
    CAShapeLayer *mask = [CAShapeLayer layer];
    mask.frame = self.bounds; mask.path = path;
    self.layer.mask = mask;
    CGPathRelease(path);
  } else self.layer.mask = nil;
  if ([overlay[@"dimmed"] boolValue]) {
    if (!self.dimmingLayer) {
      self.dimmingLayer = [CALayer layer];
      self.dimmingLayer.backgroundColor = NSColor.blackColor.CGColor;
      self.dimmingLayer.opacity = 0.4;
      self.dimmingLayer.zPosition = 100;
      [self.layer addSublayer:self.dimmingLayer];
    }
    self.dimmingLayer.frame = self.bounds;
    self.dimmingLayer.hidden = NO;
  } else self.dimmingLayer.hidden = YES;
  [CATransaction commit];
}
- (void)resizeSurface {
  if (!_surface || !self.window) return;
  CGFloat scale = self.window.backingScaleFactor;
  ghostty_surface_set_content_scale(_surface, scale, scale);
  ghostty_surface_set_size(_surface, MAX(1, self.bounds.size.width * scale), MAX(1, self.bounds.size.height * scale));
  NSNumber *display = self.window.screen.deviceDescription[@"NSScreenNumber"];
  if (display) ghostty_surface_set_display_id(_surface, display.unsignedIntValue);
}
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (_tracking) [self removeTrackingArea:_tracking];
  self.tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
    options:NSTrackingMouseMoved | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect | NSTrackingMouseEnteredAndExited
    owner:self userInfo:nil];
  [self addTrackingArea:_tracking];
}
- (void)sendKey:(NSEvent *)event action:(ghostty_input_action_e)action text:(NSString *)text composing:(BOOL)composing {
  if (!_surface) return;
  ghostty_input_key_s key = {0};
  key.action = action; key.keycode = event.keyCode;
  key.mods = modifiers(event.modifierFlags);
  key.consumed_mods = modifiers(event.modifierFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.composing = composing;
  // AppKit raises NSInternalInconsistencyException for character access on
  // flagsChanged events. That exception crosses Tao's Rust sendEvent boundary
  // and aborts the entire host, even before Ctrl-C reaches the PTY.
  NSString *plain = event.type == NSEventTypeFlagsChanged ? nil : [event charactersByApplyingModifiers:0];
  if (plain.length) { NSData *data = [plain dataUsingEncoding:NSUTF32LittleEndianStringEncoding]; if (data.length >= 4) memcpy(&key.unshifted_codepoint, data.bytes, 4); }
  if (text.length && [text characterAtIndex:0] >= 0x20 && !([text characterAtIndex:0] >= 0xf700 && [text characterAtIndex:0] <= 0xf8ff)) key.text = text.UTF8String;
  ghostty_surface_key(_surface, key);
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
  if (self.window.firstResponder != self) return NO;
  if (!(event.modifierFlags & NSEventModifierFlagCommand)) return NO;
  NSString *key = event.charactersIgnoringModifiers.lowercaseString;
  if ([key isEqual:@"t"]) { report(self, "new"); return YES; }
  if ([key isEqual:@"w"]) { report(self, "close"); return YES; }
  if ([key isEqual:@"q"]) { report(self, "quit"); return YES; }
  if ((event.modifierFlags & NSEventModifierFlagShift) && (event.keyCode == 33 || event.keyCode == 30)) {
    report(self, event.keyCode == 33 ? "previous" : "next"); return YES;
  }
  if ([key isEqual:@"c"]) { if (_surface) ghostty_surface_binding_action(_surface, "copy_to_clipboard", 17); return YES; }
  if ([key isEqual:@"v"]) { if (_surface) ghostty_surface_binding_action(_surface, "paste_from_clipboard", 20); return YES; }
  [self keyDown:event]; return YES;
}
- (void)keyDown:(NSEvent *)event {
  if (!_surface || self.inputBlocked || self.hidden) return;
  BOOL composingBefore = self.hasMarkedText;
  self.keyText = [NSMutableArray new];
  [self interpretKeyEvents:@[event]];
  const char *preedit = self.marked.string.UTF8String;
  ghostty_surface_preedit(_surface, self.hasMarkedText ? preedit : NULL, self.hasMarkedText ? strlen(preedit) : 0);
  ghostty_input_action_e action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  if (self.keyText.count) for (NSString *text in self.keyText) [self sendKey:event action:action text:text composing:NO];
  else [self sendKey:event action:action text:event.characters composing:self.hasMarkedText || composingBefore];
  self.keyText = nil;
}
- (void)keyUp:(NSEvent *)event { [self sendKey:event action:GHOSTTY_ACTION_RELEASE text:nil composing:NO]; }
- (void)flagsChanged:(NSEvent *)event {
  unsigned mask = 0;
  switch (event.keyCode) {
    case 56: case 60: mask = GHOSTTY_MODS_SHIFT; break;
    case 59: case 62: mask = GHOSTTY_MODS_CTRL; break;
    case 58: case 61: mask = GHOSTTY_MODS_ALT; break;
    case 55: case 54: mask = GHOSTTY_MODS_SUPER; break;
    case 57: mask = GHOSTTY_MODS_CAPS; break;
    default: return;
  }
  if (!self.hasMarkedText) [self sendKey:event action:(modifiers(event.modifierFlags) & mask) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE text:nil composing:NO];
}
- (void)mouseMoved:(NSEvent *)event {
  if (!_surface) return;
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(_surface, point.x, point.y, modifiers(event.modifierFlags));
}
- (void)mouseButton:(NSEvent *)event pressed:(BOOL)pressed button:(ghostty_input_mouse_button_e)button {
  if (!_surface || self.inputBlocked || self.hidden) return;
  if (pressed) [self.window makeFirstResponder:self];
  [self mouseMoved:event];
  ghostty_surface_mouse_button(_surface, pressed ? GHOSTTY_MOUSE_PRESS : GHOSTTY_MOUSE_RELEASE, button, modifiers(event.modifierFlags));
}
- (void)mouseDown:(NSEvent *)event { [self mouseButton:event pressed:YES button:GHOSTTY_MOUSE_LEFT]; }
- (void)mouseUp:(NSEvent *)event { [self mouseButton:event pressed:NO button:GHOSTTY_MOUSE_LEFT]; }
- (void)rightMouseDown:(NSEvent *)event { [self mouseButton:event pressed:YES button:GHOSTTY_MOUSE_RIGHT]; }
- (void)rightMouseUp:(NSEvent *)event { [self mouseButton:event pressed:NO button:GHOSTTY_MOUSE_RIGHT]; }
- (void)otherMouseDown:(NSEvent *)event { [self mouseButton:event pressed:YES button:GHOSTTY_MOUSE_MIDDLE]; }
- (void)otherMouseUp:(NSEvent *)event { [self mouseButton:event pressed:NO button:GHOSTTY_MOUSE_MIDDLE]; }
- (void)mouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)rightMouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)otherMouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)scrollWheel:(NSEvent *)event {
  if (!_surface) return;
  unsigned momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  if (event.momentumPhase & NSEventPhaseBegan) momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;
  else if (event.momentumPhase & NSEventPhaseChanged) momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;
  else if (event.momentumPhase & NSEventPhaseEnded) momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;
  double factor = event.hasPreciseScrollingDeltas ? 2 : 1;
  ghostty_surface_mouse_scroll(_surface, event.scrollingDeltaX * factor, event.scrollingDeltaY * factor,
                              (event.hasPreciseScrollingDeltas ? 1 : 0) | (momentum << 1));
}
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return self.hasMarkedText ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (void)setMarkedText:(id)text selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
  (void)selected; (void)replacement;
  NSString *string = [text isKindOfClass:NSAttributedString.class] ? [text string] : text;
  [self.marked replaceCharactersInRange:NSMakeRange(0, self.marked.length) withString:string];
  if (_surface && !self.keyText) ghostty_surface_preedit(_surface, string.UTF8String, strlen(string.UTF8String));
}
- (void)unmarkText { [self.marked deleteCharactersInRange:NSMakeRange(0, self.marked.length)]; if (_surface) ghostty_surface_preedit(_surface, NULL, 0); }
- (void)insertText:(id)text replacementRange:(NSRange)replacement {
  (void)replacement;
  NSString *string = [text isKindOfClass:NSAttributedString.class] ? [text string] : text;
  [self unmarkText];
  if (self.keyText) [self.keyText addObject:string];
  else if (_surface) ghostty_surface_text(_surface, string.UTF8String, strlen(string.UTF8String));
}
- (void)doCommandBySelector:(SEL)selector { (void)selector; }
- (NSUInteger)characterIndexForPoint:(NSPoint)point { (void)point; return 0; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual { (void)range; if (actual) *actual = NSMakeRange(NSNotFound, 0); return nil; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  (void)range; if (actual) *actual = self.markedRange;
  double x = 0, y = 0, width = 1, height = 18;
  if (_surface) ghostty_surface_ime_point(_surface, &x, &y, &width, &height);
  return [self.window convertRectToScreen:[self convertRect:NSMakeRect(x, y, width, height) toView:nil]];
}
@end

bool phi_terminal_init(phi_terminal_callback callback, const char *resources) {
  NSCAssert(NSThread.isMainThread, @"Terminal requires main thread");
  emit = callback;
  if (core) return true;
  if (resources && *resources) setenv("GHOSTTY_RESOURCES_DIR", resources, 1);
  if (ghostty_init(sizeof(arguments) / sizeof(arguments[0]), arguments) != 0) return false;
  ghostty_config_t config = hostConfig(false, nil);
  ghostty_runtime_config_s runtime = {0};
  runtime.wakeup_cb = wakeup; runtime.action_cb = action;
  runtime.read_clipboard_cb = readClipboard; runtime.confirm_read_clipboard_cb = confirmClipboard;
  runtime.write_clipboard_cb = writeClipboard; runtime.close_surface_cb = closeSurface;
  core = ghostty_app_new(&runtime, config);
  ghostty_config_free(config);
  if (!core) return false;
  views = [NSMutableDictionary new];
  // Dock / Cmd-Q use AppKit's delegate instead of Tauri ExitRequested.
  Class delegateClass = object_getClass(NSApp.delegate);
  SEL terminateSelector = @selector(applicationShouldTerminate:);
  Method terminateMethod = class_getInstanceMethod(delegateClass, terminateSelector);
  if (terminateMethod) originalTerminate = method_getImplementation(terminateMethod);
  class_replaceMethod(delegateClass, terminateSelector, (IMP)guardedTerminate, "Q@:@");
  for (NSString *name in @[NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
                           NSWindowDidChangeScreenNotification, NSWindowDidMiniaturizeNotification,
                           NSWindowDidDeminiaturizeNotification]) {
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      for (PHITerminalView *view in views.allValues) {
        if (note.object == view.window) {
          if ([note.name isEqual:NSWindowDidResignKeyNotification])
            view.restoreFocusOnActivate = !view.hidden && !view.inputBlocked && view.window.firstResponder == view;
          if ([note.name isEqual:NSWindowDidBecomeKeyNotification] && view.restoreFocusOnActivate) {
            view.restoreFocusOnActivate = NO;
            if (!view.hidden && !view.inputBlocked) [view.window makeFirstResponder:view];
          }
        }
        BOOL active = view.window.isKeyWindow && !view.hidden && !view.inputBlocked && !view.window.isMiniaturized;
        ghostty_surface_set_focus(view.surface, active && view.window.firstResponder == view);
        ghostty_surface_set_occlusion(view.surface, !view.hidden && view.window.isVisible && !view.window.isMiniaturized);
        [view resizeSurface];
      }
      ghostty_app_set_focus(core, NSApp.active);
    }];
  }
  for (NSString *name in @[NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification]) {
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      (void)note; ghostty_app_set_focus(core, NSApp.active);
    }];
  }
  return true;
}
bool phi_terminal_create(void *windowPointer, const char *id, const char *command,
                         const char *cwd, const char *environment) {
  if (!core) return false;
  NSString *key = [NSString stringWithUTF8String:id];
  if (views[key]) return false;
  NSWindow *window = (__bridge NSWindow *)windowPointer;
  PHITerminalView *view = [[PHITerminalView alloc] initWithFrame:NSMakeRect(0, 0, 640, 400)];
  view.sessionId = key; view.hidden = YES;
  [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil];
  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void *)view;
  config.userdata = (__bridge void *)view;
  config.scale_factor = window.backingScaleFactor;
  config.working_directory = cwd; config.command = command; config.wait_after_command = true;
  NSDictionary *env = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:environment] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  ghostty_env_var_s *variables = calloc(env.count, sizeof(ghostty_env_var_s));
  NSUInteger index = 0;
  for (NSString *name in env) variables[index++] = (ghostty_env_var_s){name.UTF8String, [env[name] UTF8String]};
  config.env_vars = variables; config.env_var_count = env.count;
  view.surface = ghostty_surface_new(core, &config);
  free(variables);
  if (!view.surface) { [view removeFromSuperview]; return false; }
  views[key] = view;
  ghostty_surface_set_focus(view.surface, false);
  ghostty_surface_set_occlusion(view.surface, false);
  [view resizeSurface];
  return true;
}
void phi_terminal_hide(void) {
  for (PHITerminalView *view in views.allValues) {
    if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
    view.hidden = YES;
    view.restoreFocusOnActivate = NO;
    ghostty_surface_set_focus(view.surface, false);
    ghostty_surface_set_occlusion(view.surface, false);
  }
}
void phi_terminal_present(const char *id, double x, double y, double width,
                          double height, bool visible, bool focus, bool dark,
                          const char *theme_config, const char *overlay_config) {
  PHITerminalView *view = views[[NSString stringWithUTF8String:id]];
  if (!view) return;
  for (PHITerminalView *other in views.allValues) if (other != view) {
    if (other.window.firstResponder == other) [other.window makeFirstResponder:nil];
    other.hidden = YES; other.restoreFocusOnActivate = NO;
    ghostty_surface_set_focus(other.surface, false); ghostty_surface_set_occlusion(other.surface, false);
  }
  NSString *colors = theme_config ? [NSString stringWithUTF8String:theme_config] : @"";
  if (darkTheme != dark || ![activeThemeConfig isEqualToString:colors]) {
    darkTheme = dark;
    activeThemeConfig = [colors copy];
    ghostty_config_t config = hostConfig(dark, colors);
    ghostty_app_update_config(core, config); ghostty_config_free(config);
  }
  NSView *container = view.superview;
  CGFloat nativeY = container.isFlipped ? y : container.bounds.size.height - y - height;
  view.frame = NSIntersectionRect(NSMakeRect(x, nativeY, width, height), container.bounds);
  NSDictionary *overlay = overlay_config ? [NSJSONSerialization JSONObjectWithData:
    [[NSString stringWithUTF8String:overlay_config] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : @{};
  [view updateOverlay:overlay];
  view.hidden = !visible;
  ghostty_surface_set_occlusion(view.surface, visible && view.window.isVisible && !view.window.isMiniaturized);
  if (!visible || view.inputBlocked) {
    view.restoreFocusOnActivate = NO;
    if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
    ghostty_surface_set_focus(view.surface, false);
  } else if (focus) {
    [view.window makeFirstResponder:view];
    // AppKit can already consider this view first responder after activation;
    // explicitly synchronize Ghostty instead of relying on another callback.
    ghostty_app_set_focus(core, NSApp.active);
    ghostty_surface_set_focus(view.surface, view.window.firstResponder == view);
  }
  [view resizeSurface];
}
bool phi_terminal_exited(const char *id) {
  PHITerminalView *view = views[[NSString stringWithUTF8String:id]];
  return !view || ghostty_surface_process_exited(view.surface);
}
void phi_terminal_close(const char *id) {
  NSString *key = [NSString stringWithUTF8String:id];
  PHITerminalView *view = views[key];
  if (!view) return;
  if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
  view.hidden = YES;
  ghostty_surface_t surface = view.surface; view.surface = NULL;
  ghostty_surface_free(surface);
  [view removeFromSuperview]; [views removeObjectForKey:key];
}
void phi_terminal_shutdown(void) {
  for (NSString *key in [views.allKeys copy]) phi_terminal_close(key.UTF8String);
}
bool phi_terminal_confirm_quit(void) {
  NSUInteger count = 0;
  for (PHITerminalView *view in views.allValues) if (!ghostty_surface_process_exited(view.surface)) count++;
  if (!count) return true;
  return confirm(NSLocalizedString(@"Quit PHI?", nil),
    [NSString stringWithFormat:NSLocalizedString(@"This will end %lu running terminal sessions.", nil), count],
    NSLocalizedString(@"End sessions and quit", nil));
}
