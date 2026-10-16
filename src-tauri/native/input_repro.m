// 终端文字输入复现试验台：链接真实的 terminal.m + libghostty，
// 开一个 surface 跑「读一行写到文件」的脚本，注入合成 keyDown，验证文字是否到达 PTY。
// 用法：phi_input_repro [a b c] —— 默认发 a、b、c 加回车，结果写在 /tmp/phi_input_result.txt
#import <Cocoa/Cocoa.h>
#import "terminal.h"

static void reproEvent(const char *id, const char *event) {
  NSLog(@"[repro] event id=%s event=%s", id, event);
}

static void sendKey(NSView *view, NSString *chars, unsigned short keyCode,
                    NSEventModifierFlags mods) {
  NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                    location:NSZeroPoint
                               modifierFlags:mods
                                   timestamp:[[NSDate date] timeIntervalSinceReferenceDate]
                                windowNumber:view.window.windowNumber
                                     context:nil
                                  characters:chars
                 charactersIgnoringModifiers:chars
                                   isARepeat:NO
                                     keyCode:keyCode];
  NSLog(@"[repro] keyDown %@ (keyCode %d) via postEvent", chars, keyCode);
  [NSApp postEvent:event atStart:NO];
}

int main(int argc, const char **argv) {
  NSApplication *app = [NSApplication sharedApplication];
  (void)argc; (void)argv;
  [app setActivationPolicy:NSApplicationActivationPolicyAccessory];

  NSString *resources = @"src-tauri/ghostty-sdk/share/ghostty";
  NSString *resultPath = @"/tmp/phi_input_result.txt";
  remove(resultPath.fileSystemRepresentation);

  NSLog(@"[repro] init ghostty…");
  if (!phi_terminal_init(reproEvent, resources.UTF8String)) {
    NSLog(@"[repro] FAIL: ghostty init");
    return 1;
  }

  NSWindow *window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(100, 100, 640, 400)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  window.title = @"phi input repro";
  [window makeKeyAndOrderFront:nil];

  // 读一行（等回车），把收到的内容原样写文件。
  // REAL 模式：跑真实 codex CLI（session.sh 同款流程），Ctrl+C 退出，进 zsh 后
  // 盲打 `echo ok > /tmp/phi_zsh_result.txt` + 回车，验证 CLI 退出后的输入状态。
  // TUI 模式：先模拟 TUI 开启 Kitty 键盘（push flags 8|16）+ modifyOtherKeys，
  // 再走 session.sh 的同款 supervisor 重置，验证重置在 Ghostty 1.2.3 上是否有效。
  NSString *script;
  if (getenv("REAL_MODE")) {
    script = @"nothing";  // REAL 模式直接用 session.sh + codex（经包装脚本规避引号问题）
  } else if (getenv("TUI_MODE")) {
    // push 全量 flags（1|2|4|8|16 = 31，含“所有键报告为转义序列”）：
    // 只有这样 pop 失败时才会以转义垃圾的形式显形。flag 1 单独 push 测不出来。
    script = @"#!/bin/sh\n"
              "printf '\\033[>31u'\n"
              "printf '\\033[>4;2m'\n"
              "sleep 0.5\n"
              "/bin/stty sane\n"
              "printf '\\033[?2026l\\033[<255u\\033[=0;1u\\033[>4;0m\\033[?1l\\033>\\033[?2004l\\033[?25h\\033[0m'\n"
              "read -r line\n"
              "printf '%s' \"$line\" > /tmp/phi_input_result.txt\n";
  } else {
    script = @"#!/bin/sh\nread -r line\nprintf '%s' \"$line\" > /tmp/phi_input_result.txt\n";
  }
  NSString *command;
  if (getenv("REAL_MODE")) {
    // 真实流程：session.sh + codex（与 App 的 session_command 一致，仅不经 login 包装）
    NSString *sessionSh = [NSString stringWithContentsOfFile:
      @"src-tauri/src/terminal/session.sh" encoding:NSUTF8StringEncoding error:nil];
    [sessionSh writeToFile:@"/tmp/phi_session_test.sh"
                atomically:YES encoding:NSUTF8StringEncoding error:nil];
    // 包装脚本规避 ghostty 命令行分词的引号问题；codex 的 stderr 落文件便于诊断
    NSString *codex = @"/Users/yanghuaiyuan/.nvm/versions/node/v24.13.0/bin/codex";
    NSString *wrapper = [NSString stringWithFormat:
      @"#!/bin/sh\n/bin/sh /tmp/phi_session_test.sh /bin/zsh '%@'\n", codex];
    [wrapper writeToFile:@"/tmp/phi_real_wrap.sh"
              atomically:YES encoding:NSUTF8StringEncoding error:nil];
    system("/bin/chmod +x /tmp/phi_real_wrap.sh");
    command = @"/bin/sh /tmp/phi_real_wrap.sh";
  } else {
    [script writeToFile:@"/tmp/phi_read_line.sh" atomically:YES encoding:NSUTF8StringEncoding error:nil];
    system("/bin/chmod +x /tmp/phi_read_line.sh");
    command = @"/bin/sh /tmp/phi_read_line.sh";
  }

  NSLog(@"[repro] create surface… (real=%d tui=%d)", getenv("REAL_MODE") != NULL,
        getenv("TUI_MODE") != NULL);
  NSString *envJson = @"{\"PATH\":\"/Users/yanghuaiyuan/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin:/usr/bin:/bin\",\"HOME\":\"/Users/yanghuaiyuan\",\"TERM\":\"xterm-256color\"}";
  if (!phi_terminal_create((__bridge void *)window, "t1:1",
                           command.UTF8String, "/Users/yanghuaiyuan/AI/ai.md", envJson.UTF8String)) {
    NSLog(@"[repro] FAIL: surface create");
    return 1;
  }
  phi_terminal_present("t1:1", 0, 0, 620, 380, true, false, false, NULL, NULL);

  // 找到终端视图（contentView 的子视图）
  NSView *view = nil;
  for (NSView *child in window.contentView.subviews) view = child;
  if (!view) { NSLog(@"[repro] FAIL: no view"); return 1; }
  [window makeFirstResponder:view];
  NSLog(@"[repro] first responder: %@", window.firstResponder);

  double keyDelay = getenv("REAL_MODE") ? 6.0 : (getenv("TUI_MODE") ? 3.0 : 2.0);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(keyDelay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    if (getenv("REAL_MODE")) {
      // codex TUI 已起来：Ctrl+C 退出（c = keyCode 6，Ctrl 修饰）
      NSLog(@"[repro] sending Ctrl+C to exit codex");
      sendKey(view, @"\x03", 6, NSEventModifierFlagControl);
      // 等 supervisor：stty sane + 重置 + exec zsh -il（.zshrc 启动需要点时间）
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.0 * NSEC_PER_SEC)),
                     dispatch_get_main_queue(), ^{
        NSLog(@"[repro] zsh should be up; blind-typing echo command");
        NSString *line = @"echo ok > /tmp/phi_zsh_result.txt";
        for (NSUInteger i = 0; i < line.length; i++) {
          NSString *ch = [line substringWithRange:NSMakeRange(i, 1)];
          sendKey(view, ch, 0, 0);
        }
        sendKey(view, @"\r", 36, 0);
      });
      return;
    }
    NSLog(@"[repro] sending keys a b c Return");
    sendKey(view, @"a", 0, 0);
    sendKey(view, @"b", 11, 0);
    sendKey(view, @"c", 8, 0);
    sendKey(view, @"\r", 36, 0);
  });

  double resultDelay = getenv("REAL_MODE") ? 16.0 : 4.5;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(resultDelay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    phi_terminal_tick();
    NSString *checkPath = getenv("REAL_MODE") ? @"/tmp/phi_zsh_result.txt" : resultPath;
    NSString *result = [NSString stringWithContentsOfFile:checkPath
                                                 encoding:NSUTF8StringEncoding
                                                    error:nil];
    NSLog(@"[repro] RESULT file=%@ content=\"%@\"",
          result ? @"exists" : @"missing", result ?: @"(none)");
    if ([[result stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]] isEqualToString:@"ok"]) {
      NSLog(@"[repro] PASS: text reached the PTY");
      phi_terminal_shutdown();
      exit(0);
    }
    NSLog(@"[repro] FAIL: text did not reach the PTY");
    phi_terminal_shutdown();
    exit(2);
  });

  // 泵 ghostty + 保持主循环
  NSTimer *tick = [NSTimer timerWithTimeInterval:0.016 repeats:YES
                                          block:^(NSTimer *) { phi_terminal_tick(); }];
  [[NSRunLoop mainRunLoop] addTimer:tick forMode:NSRunLoopCommonModes];
  [app run];
  return 0;
}
