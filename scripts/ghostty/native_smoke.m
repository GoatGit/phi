// Isolated native integration check. No application credentials or paid CLI calls.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "terminal.h"
#import "ghostty.h"
#include <signal.h>

@interface NSView (PHISmoke)
- (ghostty_surface_t)surface;
@end
static NSMutableSet *events;
static void event(const char *id, const char *name) {
  [events addObject:[NSString stringWithFormat:@"%s:%s", id, name]];
}
static void check(BOOL ok, NSString *message) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", message.UTF8String); phi_terminal_shutdown(); exit(1); }
  fprintf(stderr, "PASS: %s\n", message.UTF8String);
}
static void pump(double seconds) {
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (until.timeIntervalSinceNow > 0)
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}
static NSString *contents(NSView *view) {
  ghostty_selection_s selection = {
    .top_left = { GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_TOP_LEFT, 0, 0 },
    .bottom_right = { GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_BOTTOM_RIGHT, 0, 0 },
    .rectangle = false,
  };
  ghostty_text_s text = {0};
  if (!ghostty_surface_read_text(view.surface, selection, &text)) return @"";
  NSString *result = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
  ghostty_surface_free_text(view.surface, &text);
  return result;
}
static void input(NSView *view, NSString *value) {
  [(id<NSTextInputClient>)view insertText:value replacementRange:NSMakeRange(NSNotFound, 0)];
}
static void submit(NSView *view, NSString *command) {
  input(view, command);
  pump(0.1);
  NSEvent *enter = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0
    timestamp:0 windowNumber:view.window.windowNumber context:nil characters:@"\r" charactersIgnoringModifiers:@"\r" isARepeat:NO keyCode:36];
  [view keyDown:enter];
}
// Exercise AppKit key dispatch, not insertText (which Ghostty treats as paste).
static void pressKey(NSView *view, NSString *characters, unsigned short keyCode, NSEventModifierFlags flags) {
  for (NSUInteger release = 0; release < 2; release++) {
    NSEvent *key = [NSEvent keyEventWithType:release ? NSEventTypeKeyUp : NSEventTypeKeyDown
      location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime
      windowNumber:view.window.windowNumber context:nil characters:characters
      charactersIgnoringModifiers:characters isARepeat:NO keyCode:keyCode];
    [NSApp sendEvent:key];
  }
}
static void physicalType(NSView *view, NSString *value) {
  // US physical key positions; tests use letters and spaces only. Unicode
  // commits use NSTextInputClient separately, as a real IME would do.
  const unsigned short letterKeys[] = {0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6};
  for (NSUInteger i = 0; i < value.length; i++) {
    NSString *character = [value substringWithRange:NSMakeRange(i, 1)];
    unichar c = [character.lowercaseString characterAtIndex:0];
    NSCAssert(c == ' ' || (c >= 'a' && c <= 'z'), @"Unsupported physical test key");
    unsigned short keyCode = c == ' ' ? 49 : letterKeys[c - 'a'];
    NSEventModifierFlags flags = [character isEqual:character.lowercaseString] ? 0 : NSEventModifierFlagShift;
    pressKey(view, character, keyCode, flags);
    pump(0.01);
  }
}
static BOOL hasLine(NSView *view, NSString *line) {
  for (NSString *row in [contents(view) componentsSeparatedByString:@"\n"])
    if ([[row stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] isEqual:line]) return YES;
  return NO;
}
static BOOL backgroundMatches(NSView *view, NSString *hex) {
  NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
  // cacheDisplay returns channel values in the bitmap's calibrated RGB space;
  // converting that snapshot to sRGB applies a second transfer curve.
  NSColor *color = [rep colorAtX:rep.pixelsWide - 20 y:rep.pixelsHigh - 20];
  unsigned expected = 0;
  [[NSScanner scannerWithString:hex] scanHexInt:&expected];
  fprintf(stderr, "Theme pixel expected=%s actual=%.3f,%.3f,%.3f\n", hex.UTF8String,
    color.redComponent, color.greenComponent, color.blueComponent);
  return color && fabs(color.redComponent - ((expected >> 16) & 255) / 255.0) < 0.035
    && fabs(color.greenComponent - ((expected >> 8) & 255) / 255.0) < 0.035
    && fabs(color.blueComponent - (expected & 255) / 255.0) < 0.035;
}
static BOOL pixelMatches(NSView *view, CGFloat x, CGFloat y, NSString *hex) {
  NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
  CGFloat scaleX = rep.pixelsWide / view.bounds.size.width, scaleY = rep.pixelsHigh / view.bounds.size.height;
  NSColor *color = [rep colorAtX:x * scaleX y:y * scaleY];
  fprintf(stderr, "Pixel %.0f,%.0f expected=%s actual=%.3f,%.3f,%.3f\n", x, y, hex.UTF8String,
    color.redComponent, color.greenComponent, color.blueComponent);
  unsigned expected = 0; [[NSScanner scannerWithString:hex] scanHexInt:&expected];
  return color && fabs(color.redComponent - ((expected >> 16) & 255) / 255.0) < 0.04
    && fabs(color.greenComponent - ((expected >> 8) & 255) / 255.0) < 0.04
    && fabs(color.blueComponent - (expected & 255) / 255.0) < 0.04;
}
int main(int argc, const char **argv) { @autoreleasepool {
  if (argc != 6) return 2;
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  events = [NSMutableSet new];
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 150, 900, 600)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
    backing:NSBackingStoreBuffered defer:NO];
  window.title = @"PHI · Ghostty integration check";
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
  WKWebView *web = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration];
  web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [window.contentView addSubview:web];
  [web loadHTMLString:@"<meta charset='utf-8'><style>body{margin:0;font:14px -apple-system;background:#f4f4f5;color:#27272a}aside{width:175px;padding:20px;box-sizing:border-box}header{position:absolute;left:175px;right:0;top:0;height:84px;box-sizing:border-box;padding:20px;background:white;border-bottom:1px solid #ddd}button{margin:0 8px;padding:6px 12px}footer{position:absolute;bottom:0;left:175px;padding:12px}</style><aside><h2>PHI</h2><p>Claude Code</p><p>Codex</p><p>Gemini CLI</p></aside><header>应用终端 <button>配置</button><button>● 原生 PTY ×</button> ＋</header><footer>原生 Ghostty 与 WKWebView 共存检查</footer><input id=launch value=WORKSPACE autofocus>" baseURL:nil];
  [NSApp finishLaunching];
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  pump(0.5);
  [window makeFirstResponder:web];
  [web evaluateJavaScript:@"document.querySelector('input').focus()" completionHandler:nil];
  pump(0.2);
  check(phi_terminal_init(event, argv[1]), @"engine initializes without Ghostty.app");
  check(phi_terminal_create((__bridge void *)window, "first:1",
    "/bin/sh -c 'printf \"READY / 中文 / \\033[32mANSI PASS\\033[0m\\n\"; read line; printf \"INPUT:%s\\n\" \"$line\"; read line; printf \"PHYSICAL:%s\\n\" \"$line\"; read line; exit 7'", "/tmp", "{}"), @"real shell/PTY created");
  NSView *first = window.contentView.subviews.lastObject;
  phi_terminal_present("first:1", 175, 84, 725, 472, true, true, false, NULL, NULL);
  pump(2);
  check([contents(first) containsString:@"READY / 中文 / ANSI PASS"], @"PTY output and wide characters rendered");
  check(window.firstResponder == first && first.superview == web.superview, @"native sibling receives focus inside WebView layout");
  check([window.contentView hitTest:NSMakePoint(220, 500)] == first, @"terminal rectangle receives native input");
  check([window.contentView hitTest:NSMakePoint(40, 500)] != first, @"sidebar remains interactive");
  [(id<NSTextInputClient>)first setMarkedText:@"拼音" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
  check([(id<NSTextInputClient>)first hasMarkedText], @"IME preedit retained");
  input(first, @"中文输入\n"); pump(0.4);
  check([contents(first) containsString:@"INPUT:中文输入"], @"committed Chinese input reaches real PTY");
  physicalType(first, @"physical"); pump(0.1);
  check([contents(first) containsString:@"physical"], @"character keys are echoed before Return");
  pressKey(first, @"\r", 36, 0); pump(0.3);
  check([contents(first) containsString:@"PHYSICAL:physical"], @"physical character key events reach real PTY");
  NSEvent *shortcut = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand
    timestamp:0 windowNumber:window.windowNumber context:nil characters:@"t" charactersIgnoringModifiers:@"t" isARepeat:NO keyCode:17];
  check([first performKeyEquivalent:shortcut] && [events containsObject:@"first:1:new"], @"native Command-T reaches workspace action");
  check(phi_terminal_create((__bridge void *)window, "second:1", "/bin/sh -c 'printf SECOND; read line'", "/tmp", "{}"), @"second independent surface created");
  NSView *second = window.contentView.subviews.lastObject;
  phi_terminal_present("second:1", 175, 84, 725, 472, true, true, true, NULL, NULL); pump(0.5);
  check(first.hidden && !second.hidden && [contents(second) containsString:@"SECOND"], @"switching surfaces preserves first process");
  phi_terminal_hide();
  check(first.hidden && second.hidden && !phi_terminal_exited("first:1"), @"overlay hides views without closing sessions");
  check(window.firstResponder != second, @"hidden native view releases keyboard focus");
  [window makeFirstResponder:web];
  [window setContentSize:NSMakeSize(1000, 650)];
  phi_terminal_present("first:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.3);
  check(first.frame.size.width == 825 && [contents(first) containsString:@"INPUT:中文输入"], @"resize and restore preserve terminal buffer");
  // cacheDisplay cannot capture WKWebView's out-of-process layer. Place a
  // colored fixture on the same underlying plane to verify actual mask pixels.
  NSView *popupPlane = [[NSView alloc] initWithFrame:NSMakeRect(700, 450, 160, 100)];
  popupPlane.wantsLayer = YES;
  popupPlane.layer.backgroundColor = [NSColor colorWithSRGBRed:32/255.0 green:64/255.0 blue:208/255.0 alpha:1].CGColor;
  [window.contentView addSubview:popupPlane positioned:NSWindowBelow relativeTo:first];
  const char *overlay = "{\"blocked\":true,\"rects\":[{\"x\":525,\"y\":16,\"width\":160,\"height\":100},{\"x\":550,\"y\":30,\"width\":80,\"height\":60}]}";
  phi_terminal_present("first:1", 175, 84, 825, 522, true, false, true, "background = 101010", overlay); pump(0.4);
  NSBitmapImageRep *overlayImage = [window.contentView bitmapImageRepForCachingDisplayInRect:window.contentView.bounds];
  [window.contentView cacheDisplayInRect:window.contentView.bounds toBitmapImageRep:overlayImage];
  [[overlayImage representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/phi-native-overlay.png" atomically:YES];
  check(!first.hidden && !phi_terminal_exited("first:1") && [contents(first) containsString:@"INPUT:中文输入"], @"opening menus leaves the native terminal live and visible");
  check(pixelMatches(window.contentView, 500, 350, @"101010"), @"menu does not whiten the uncovered terminal area");
  check(pixelMatches(window.contentView, 750, 140, @"2040d0"), @"underlying popup plane is visible through overlapping exclusion rectangles");
  check(window.firstResponder != first && [window.contentView hitTest:NSMakePoint(500, 300)] != first,
    @"open menu owns keyboard and outside clicks without hiding terminal output");
  [popupPlane removeFromSuperview];
  phi_terminal_present("first:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.2);
  check(window.firstResponder == first && !first.layer.mask, @"closing menu restores terminal focus and its full rendering area");
  const char *tooltip = "{\"blocked\":false,\"rects\":[{\"x\":525,\"y\":16,\"width\":160,\"height\":100}]}";
  phi_terminal_present("first:1", 175, 84, 825, 522, true, false, false, NULL, tooltip);
  check(window.firstResponder == first && [window.contentView hitTest:NSMakePoint(500, 300)] == first,
    @"hover tooltip never disables terminal input outside its own rectangle");
  phi_terminal_present("first:1", 175, 84, 825, 522, true, true, false, NULL, NULL);
  [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidResignKeyNotification object:window];
  [window makeFirstResponder:web];
  [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidBecomeKeyNotification object:window];
  check(window.firstResponder == first, @"returning to the application restores the previous native responder");
  NSArray *themes = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]] options:0 error:nil];
  check(themes.count == 6, @"bundled theme catalog available offline");
  ghostty_surface_t originalSurface = first.surface;
  for (NSDictionary *theme in themes) {
    NSMutableString *colors = [NSMutableString stringWithFormat:@"background = %@\nforeground = %@\ncursor-color = %@\ncursor-text = %@\nselection-background = %@\nselection-foreground = %@\n", theme[@"background"], theme[@"foreground"], theme[@"cursor"], theme[@"background"], theme[@"selection"], theme[@"foreground"]];
    NSUInteger index = 0;
    for (NSString *color in theme[@"palette"]) [colors appendFormat:@"palette = %lu=%@\n", index++, color];
    phi_terminal_present("first:1", 175, 84, 825, 522, true, true, false, colors.UTF8String, NULL); pump(0.2);
    check(backgroundMatches(first, theme[@"background"]), [@"rendered theme: " stringByAppendingString:theme[@"id"]]);
    check(first.surface == originalSurface && !phi_terminal_exited("first:1") && [contents(first) containsString:@"INPUT:中文输入"], @"theme switch preserves PTY and output");
    phi_terminal_present("second:1", 175, 84, 825, 522, true, true, false, colors.UTF8String, NULL); pump(0.2);
    check(backgroundMatches(second, theme[@"background"]) && [contents(second) containsString:@"SECOND"], @"theme reaches other running tabs");
  }
  phi_terminal_present("first:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.2);
  NSBitmapImageRep *rep = [window.contentView bitmapImageRepForCachingDisplayInRect:window.contentView.bounds];
  [window.contentView cacheDisplayInRect:window.contentView.bounds toBitmapImageRep:rep];
  [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithUTF8String:argv[2]] atomically:YES];
  input(first, @"done\n"); pump(0.7);
  check(phi_terminal_exited("first:1") && [events containsObject:@"first:1:exited"], @"nonzero exit emits lifecycle event and preserves output");
  phi_terminal_close("first:1");
  check(!first.superview && !first.surface, @"close releases native surface");
  check(phi_terminal_create((__bridge void *)window, "interrupt:1",
    argv[4], "/tmp", "{}"), @"interrupt test uses the production session supervisor and a real PTY");
  NSView *interrupted = window.contentView.subviews.lastObject;
  phi_terminal_present("interrupt:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.5);
  check([contents(interrupted) containsString:@"INTERRUPT_READY"], @"foreground CLI is ready for Ctrl-C");
  NSEvent *controlDown = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagControl
    timestamp:0 windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:59];
  NSEvent *interrupt = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagControl
    timestamp:0 windowNumber:window.windowNumber context:nil characters:@"\003" charactersIgnoringModifiers:@"c" isARepeat:NO keyCode:8];
  NSEvent *controlUp = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:0
    timestamp:0 windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:59];
  [window sendEvent:controlDown];
  [window sendEvent:interrupt];
  NSEvent *interruptUp = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:NSEventModifierFlagControl
    timestamp:0 windowNumber:window.windowNumber context:nil characters:@"\003" charactersIgnoringModifiers:@"c" isARepeat:NO keyCode:8];
  [window sendEvent:interruptUp];
  [window sendEvent:controlUp];
  pump(0.6);
  check(!phi_terminal_exited("interrupt:1") && [contents(interrupted) containsString:@"INTERRUPTED"], @"Ctrl-C exits the CLI while its terminal stays alive");
  check(![events containsObject:@"interrupt:1:exited"], @"CLI exit does not mark the terminal session exited");
  submit(interrupted, @"printf 'SHELL_%s\\n' READY"); pump(0.4);
  check([contents(interrupted) containsString:@"SHELL_READY"], @"same terminal accepts shell commands after CLI exit");
  phi_terminal_present("interrupt:1", 175, 84, 825, 522, true, false, false, NULL, overlay);
  [window makeFirstResponder:web];
  phi_terminal_present("interrupt:1", 175, 84, 825, 522, true, true, false, NULL, NULL);
  submit(interrupted, @"printf 'MENU_%s\\n' INPUT"); pump(0.3);
  check([contents(interrupted) containsString:@"MENU_INPUT"], @"shell accepts real input after menu dismissal");
  [window makeFirstResponder:web];
  NSPoint clickPoint = [interrupted convertPoint:NSMakePoint(300, 250) toView:nil];
  NSEvent *click = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:clickPoint modifierFlags:0
    timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
  [window sendEvent:click];
  check(window.firstResponder == interrupted, @"clicking a visible terminal recovers keyboard focus from WebView");
  submit(interrupted, @"printf 'CLICK_%s\\n' INPUT"); pump(0.3);
  check([contents(interrupted) containsString:@"CLICK_INPUT"], @"shell accepts real input after click-to-focus recovery");
  [window sendEvent:controlDown]; [window sendEvent:interrupt]; [window sendEvent:interruptUp]; [window sendEvent:controlUp]; pump(0.2);
  submit(interrupted, @"printf 'AFTER_%s\\n' INTERRUPT"); pump(0.4);
  check(!phi_terminal_exited("interrupt:1") && [contents(interrupted) containsString:@"AFTER_INTERRUPT"], @"Ctrl-C at the shell prompt keeps the terminal usable");
  check(![events containsObject:@"interrupt:1:quit"] && window.isVisible, @"Ctrl-C leaves the host application open");
  check(!phi_terminal_exited("second:1") && [contents(second) containsString:@"SECOND"], @"Ctrl-C leaves other terminal processes running");
  submit(interrupted, @"exit"); pump(0.5);
  check(phi_terminal_exited("interrupt:1") && [events containsObject:@"interrupt:1:exited"], @"only explicit shell exit ends the terminal session");
  phi_terminal_close("interrupt:1");
  phi_terminal_present("second:1", 175, 84, 825, 522, true, true, false, NULL, NULL);
  unsigned short modifierKeys[] = {56, 60, 59, 62, 58, 61, 55, 54, 57};
  NSEventModifierFlags modifierMasks[] = {NSEventModifierFlagShift, NSEventModifierFlagShift,
    NSEventModifierFlagControl, NSEventModifierFlagControl, NSEventModifierFlagOption, NSEventModifierFlagOption,
    NSEventModifierFlagCommand, NSEventModifierFlagCommand, NSEventModifierFlagCapsLock};
  for (NSUInteger i = 0; i < sizeof(modifierKeys) / sizeof(modifierKeys[0]); i++) {
    for (NSUInteger pressed = 0; pressed < 2; pressed++) {
      NSEvent *modifier = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:pressed ? 0 : modifierMasks[i]
        timestamp:0 windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:modifierKeys[i]];
      [window sendEvent:modifier];
    }
  }
  check(!phi_terminal_exited("second:1"), @"left/right modifiers and Caps Lock never perform invalid character access");
  phi_terminal_close("second:1");
  check(phi_terminal_create((__bridge void *)window, "dirty:1", argv[5], "/tmp", "{}"), @"raw CLI fixture uses the production session supervisor");
  NSView *dirty = window.contentView.subviews.lastObject;
  phi_terminal_present("dirty:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.8);
  check([contents(dirty) containsString:@"DIRTY_CLI_READY"], @"CLI enters raw mode and enhanced keyboard protocol");
  physicalType(dirty, @"a"); pump(0.15);
  check([contents(dirty) containsString:@"KITTY_KEY_RECEIVED"], @"running CLI retains its enhanced keyboard protocol");
  [window sendEvent:controlDown]; [window sendEvent:interrupt]; [window sendEvent:interruptUp]; [window sendEvent:controlUp]; pump(0.7);
  check(!phi_terminal_exited("dirty:1") && [contents(dirty) containsString:@"DIRTY_CLI_INTERRUPTED"], @"Ctrl-C exits raw CLI even when it leaves keyboard and display modes behind");
  physicalType(dirty, @"echo recovered"); pump(0.2);
  check([contents(dirty) containsString:@"echo recovered"], @"after Ctrl-C the shell echoes physical characters before Return");
  NSBitmapImageRep *inputImage = [dirty bitmapImageRepForCachingDisplayInRect:dirty.bounds];
  [dirty cacheDisplayInRect:dirty.bounds toBitmapImageRep:inputImage];
  NSString *inputScreenshot = [[NSString stringWithUTF8String:argv[2]] stringByReplacingOccurrencesOfString:@"native.png" withString:@"input.png"];
  [[inputImage representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:inputScreenshot atomically:YES];
  pressKey(dirty, @"\r", 36, 0); pump(0.3);
  check(hasLine(dirty, @"recovered"), @"after Ctrl-C the physically typed shell command executes");
  physicalType(dirty, @"echo ");
  [(id<NSTextInputClient>)dirty setMarkedText:@"中文" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
  input(dirty, @"中文"); pump(0.2);
  check([contents(dirty) containsString:@"echo 中文"], @"after Ctrl-C Chinese IME commit is visible before Return");
  pressKey(dirty, @"\r", 36, 0); pump(0.3);
  check(hasLine(dirty, @"中文"), @"after Ctrl-C Chinese shell input executes");
  check([contents(dirty) containsString:@"DIRTY_CLI_READY"], @"mode recovery preserves earlier CLI output");
  phi_terminal_present("dirty:1", 175, 84, 825, 522, true, false, false, NULL, overlay);
  phi_terminal_present("dirty:1", 175, 84, 825, 522, true, true, true, "background = 1c1c1e\nforeground = e4e4e7", NULL);
  physicalType(dirty, @"echo menu"); pump(0.1);
  check([contents(dirty) containsString:@"echo menu"], @"menu/theme roundtrip preserves physical input after CLI exit");
  pressKey(dirty, @"\r", 36, 0); pump(0.2);
  check(hasLine(dirty, @"menu"), @"shell command executes after menu/theme roundtrip");
  phi_terminal_close("dirty:1");
  check(phi_terminal_create((__bridge void *)window, "stubborn:1",
    "/bin/sh -c 'trap \"\" HUP; printf \"PID:%s\\n\" \"$$\"; while :; do sleep 1; done'", "/tmp", "{}"), @"HUP-ignoring child created");
  NSView *stubborn = window.contentView.subviews.lastObject;
  phi_terminal_present("stubborn:1", 175, 84, 825, 522, true, true, false, NULL, NULL); pump(0.7);
  NSString *buffer = contents(stubborn);
  NSRange marker = [buffer rangeOfString:@"PID:"];
  check(marker.location != NSNotFound, @"child PID read from isolated test only");
  pid_t pid = [[buffer substringFromIndex:NSMaxRange(marker)] intValue];
  check(pid > 1 && pid != getpid(), @"test owns a separate process");
  NSDate *start = [NSDate date];
  phi_terminal_close("stubborn:1");
  check(-start.timeIntervalSinceNow < 4, @"uncooperative child close is bounded");
  pump(0.5); // Allow launchd to reap any orphaned grandchildren.
  check(kill(pid, 0) == -1 && errno == ESRCH, @"uncooperative child reaped");
  check(phi_terminal_confirm_quit(), @"no confirmation needed after all processes close");
  phi_terminal_shutdown();
  fprintf(stderr, "NATIVE_SMOKE_OK\n");
  return 0;
} }
