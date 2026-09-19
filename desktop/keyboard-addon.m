// SPDX-License-Identifier: GPL-3.0-only
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <assert.h>
#include <math.h>
#include <mach/mach_time.h>
#include <string.h>
#ifndef VD_KEYBOARD_CHECK
#include <node_api.h>
#endif

static const CGEventFlags modifierFlags[] = { kCGEventFlagMaskCommand, kCGEventFlagMaskControl,
    kCGEventFlagMaskAlternate, kCGEventFlagMaskShift, kCGEventFlagMaskSecondaryFn };
static const CGKeyCode modifierKeys[] = { kVK_Command, kVK_Control, kVK_Option, kVK_Shift, kVK_Function };
static const CGEventFlags allowedFlags = kCGEventFlagMaskCommand | kCGEventFlagMaskControl |
    kCGEventFlagMaskAlternate | kCGEventFlagMaskShift | kCGEventFlagMaskSecondaryFn;
typedef struct { CGEventRef events[402]; size_t count; } KeyEvents;
static void clearEvents(KeyEvents *list) {
    for (size_t i = 0; i < list->count; ++i) CFRelease(list->events[i]);
    list->count = 0;
}
static bool appendEvent(KeyEvents *list, CGEventSourceRef source, CGKeyCode key, bool down, CGEventFlags flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(source, key, down);
    if (!event) return false;
    CGEventSetFlags(event, flags);
    list->events[list->count++] = event;
    return true;
}
// Allocate the complete down/up sequence first. Allocation failure never leaves a modifier down.
static bool prepareKeys(KeyEvents *list, CGKeyCode key, CGEventFlags flags) {
    if (key > 127 || (flags & ~allowedFlags)) return false;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return false;
    bool ok = true;
    CGEventFlags singleFlag = 0;
    switch (key) {
        case kVK_Option: singleFlag = kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK; break;
        case kVK_RightOption: singleFlag = kCGEventFlagMaskAlternate | NX_DEVICERALTKEYMASK; break;
        case kVK_Control: singleFlag = kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK; break;
        case kVK_RightControl: singleFlag = kCGEventFlagMaskControl | NX_DEVICERCTLKEYMASK; break;
        case kVK_Shift: singleFlag = kCGEventFlagMaskShift | NX_DEVICELSHIFTKEYMASK; break;
        case kVK_RightShift: singleFlag = kCGEventFlagMaskShift | NX_DEVICERSHIFTKEYMASK; break;
        case kVK_Command: singleFlag = kCGEventFlagMaskCommand | NX_DEVICELCMDKEYMASK; break;
        case kVK_RightCommand: singleFlag = kCGEventFlagMaskCommand | NX_DEVICERCMDKEYMASK; break;
    }
    if (singleFlag) {
        if (flags != 0) { CFRelease(source); return false; }
        ok = appendEvent(list, source, key, true, singleFlag);
        if (ok) CGEventSetType(list->events[list->count - 1], kCGEventFlagsChanged);
        if (ok) ok = appendEvent(list, source, key, false, 0);
        if (ok) CGEventSetType(list->events[list->count - 1], kCGEventFlagsChanged);
        CFRelease(source);
        if (!ok) clearEvents(list);
        return ok;
    }
    CGEventFlags active = 0;
    for (size_t i = 0; ok && i < 5; ++i) if (flags & modifierFlags[i]) {
        active |= modifierFlags[i]; ok = appendEvent(list, source, modifierKeys[i], true, active);
    }
    if (ok) ok = appendEvent(list, source, key, true, flags);
    if (ok) ok = appendEvent(list, source, key, false, flags);
    for (int i = 4; ok && i >= 0; --i) if (flags & modifierFlags[i]) {
        active &= ~modifierFlags[i]; ok = appendEvent(list, source, modifierKeys[i], false, active);
    }
    CFRelease(source);
    if (!ok) clearEvents(list);
    return ok;
}
// Prepare bounded Unicode chunks without splitting UTF-16 surrogate pairs.
static bool prepareText(KeyEvents *list, NSString *text) {
    if (!text.length || text.length > 2000) return false;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return false;
    bool ok = true;
    for (NSUInteger offset = 0; ok && offset < text.length;) {
        NSUInteger length = MIN((NSUInteger)20, text.length - offset);
        if (offset + length < text.length && CFStringIsSurrogateHighCharacter([text characterAtIndex:offset + length - 1])) length--;
        UniChar chars[20];
        [text getCharacters:chars range:NSMakeRange(offset, length)];
        for (int down = 1; ok && down >= 0; down--) {
            ok = appendEvent(list, source, 0, down, 0);
            if (ok) CGEventKeyboardSetUnicodeString(list->events[list->count - 1], length, chars);
        }
        offset += length;
    }
    CFRelease(source);
    if (!ok) clearEvents(list);
    return ok;
}
#ifdef VD_KEYBOARD_CHECK
int main(void) {
    @autoreleasepool {
        for (unsigned combination = 0; combination < 32; ++combination) {
            CGEventFlags flags = 0;
            for (size_t i = 0; i < 5; ++i) if (combination & (1u << i)) flags |= modifierFlags[i];
            KeyEvents list = {0};
            assert(prepareKeys(&list, kVK_ANSI_V, flags));
            assert(list.count == 2 + 2 * (size_t)__builtin_popcount(combination));
            int balance[128] = {0};
            for (size_t i = 0; i < list.count; ++i) {
                int key = (int)CGEventGetIntegerValueField(list.events[i], kCGKeyboardEventKeycode);
                assert(key >= 0 && key < 128);
                bool down = CGEventGetType(list.events[i]) == kCGEventKeyDown;
                if (CGEventGetType(list.events[i]) == kCGEventFlagsChanged) {
                    bool modifier = false;
                    for (size_t m = 0; m < 5; ++m) if (key == modifierKeys[m]) {
                        modifier = true; down = (CGEventGetFlags(list.events[i]) & modifierFlags[m]) != 0;
                    }
                    assert(modifier);
                }
                balance[key] += down ? 1 : -1;
                assert(balance[key] >= 0);
            }
            for (size_t i = 0; i < 128; ++i) assert(balance[i] == 0);
            assert(CGEventGetFlags(list.events[list.count - 1]) == 0);
            clearEvents(&list);
        }
        KeyEvents unicode = {0};
        KeyEvents option = {0};
        assert(prepareKeys(&option, kVK_RightOption, 0));
        assert(option.count == 2);
        assert(CGEventGetType(option.events[0]) == kCGEventFlagsChanged);
        assert(CGEventGetFlags(option.events[0]) & NX_DEVICERALTKEYMASK);
        assert(CGEventGetFlags(option.events[1]) == 0);
        clearEvents(&option);
        CGKeyCode singles[] = { kVK_Option, kVK_RightOption, kVK_Control, kVK_RightControl, kVK_Shift, kVK_RightShift, kVK_Command, kVK_RightCommand };
        for (size_t i = 0; i < sizeof(singles) / sizeof(singles[0]); ++i) {
            KeyEvents single = {0};
            assert(prepareKeys(&single, singles[i], 0));
            assert(single.count == 2 && CGEventGetType(single.events[0]) == kCGEventFlagsChanged);
            assert(CGEventGetFlags(single.events[0]) != 0 && CGEventGetFlags(single.events[1]) == 0);
            clearEvents(&single);
            assert(!prepareKeys(&single, singles[i], kCGEventFlagMaskCommand));
        }
        NSString *sample = @"1234567890123456789😀中文";
        assert(prepareText(&unicode, sample));
        NSMutableString *restored = [NSMutableString string];
        for (size_t i = 0; i < unicode.count; i += 2) {
            UniChar chars[20]; UniCharCount length = 0;
            CGEventKeyboardGetUnicodeString(unicode.events[i], 20, &length, chars);
            [restored appendString:[NSString stringWithCharacters:chars length:length]];
            assert(CGEventGetType(unicode.events[i + 1]) == kCGEventKeyUp);
        }
        assert([restored isEqualToString:sample]);
        clearEvents(&unicode);
        assert(!prepareText(&unicode, @""));
        assert(!prepareText(&unicode, [@"a" stringByPaddingToLength:2001 withString:@"a" startingAtIndex:0]));
        KeyEvents invalid = {0};
        assert(!prepareKeys(&invalid, 128, 0));
        assert(!prepareKeys(&invalid, kVK_ANSI_V, 1));
        puts("Keyboard: all 32 modifier combinations have balanced events; no events posted.");
    }
}
#else
static NSDictionary *currentTarget(void) {
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.terminated || !app.launchDate || [app.bundleIdentifier isEqualToString:@"com.apple.loginwindow"]) return nil;
    return @{ @"id": [NSString stringWithFormat:@"%d:%.0f", app.processIdentifier, app.launchDate.timeIntervalSince1970 * 1000],
        @"name": app.localizedName ?: @"未知应用", @"bundleId": app.bundleIdentifier ?: @"" };
}
static napi_value fail(napi_env env, const char *code, const char *message) {
    napi_throw_error(env, code, message); return NULL;
}
static napi_value json(napi_env env, NSDictionary *value) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    napi_value result;
    if (!bytes || napi_create_string_utf8(env, bytes.bytes, bytes.length, &result) != napi_ok)
        return fail(env, "NATIVE", "无法返回按键状态");
    return result;
}
static napi_value snapshot(napi_env env, napi_callback_info info) {
    (void)info;
    @autoreleasepool { return json(env, @{ @"trusted": @(AXIsProcessTrusted()), @"target": currentTarget() ?: NSNull.null }); }
}
static napi_value press(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        uint64_t began = mach_absolute_time();
        size_t argc = 5, length = 0;
        napi_value args[5]; char targetId[96]; double key = 0, flags, remainingMs;
        napi_valuetype type;
        NSString *text = nil;
        if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 4 ||
            napi_get_value_string_utf8(env, args[0], targetId, sizeof(targetId), &length) != napi_ok || length == 0 || length >= sizeof(targetId) - 1 || strlen(targetId) != length ||
            napi_get_value_double(env, args[2], &flags) != napi_ok || !isfinite(flags) || flags < 0 || flags > allowedFlags || floor(flags) != flags || ((uint64_t)flags & ~allowedFlags) ||
            napi_get_value_double(env, args[3], &remainingMs) != napi_ok || !isfinite(remainingMs) || remainingMs <= 0 || remainingMs > 3000)
            return fail(env, "INVALID", "按键参数无效");
        if (napi_typeof(env, args[1], &type) != napi_ok) return fail(env, "INVALID", "输入参数无效");
        if (type == napi_string) {
            char16_t chars[2001]; size_t count = 0;
            if (flags != 0 || napi_get_value_string_utf16(env, args[1], NULL, 0, &count) != napi_ok || count == 0 || count > 2000 ||
                napi_get_value_string_utf16(env, args[1], chars, 2001, &count) != napi_ok)
                return fail(env, "INVALID", "文字长度无效");
            text = [NSString stringWithCharacters:(const unichar *)chars length:count];
        } else if (napi_get_value_double(env, args[1], &key) != napi_ok || !isfinite(key) || key < 0 || key > 127 || floor(key) != key)
            return fail(env, "INVALID", "按键参数无效");
        if (!AXIsProcessTrusted()) return fail(env, "PERMISSION", "请在 Mac 系统设置中为语音快捷键盘开启辅助功能权限");
        NSDictionary *target = currentTarget();
        NSString *expected = [NSString stringWithUTF8String:targetId];
        if (!target || ![target[@"id"] isEqualToString:expected]) return fail(env, "TARGET_CHANGED", "前台应用已变化，请刷新目标后重试");
        KeyEvents list = {0};
        if (!(text ? prepareText(&list, text) : prepareKeys(&list, (CGKeyCode)key, (CGEventFlags)flags))) return fail(env, "NATIVE", "无法创建按键事件");
        if (![currentTarget()[@"id"] isEqualToString:expected]) {
            clearEvents(&list); return fail(env, "TARGET_CHANGED", "前台应用已变化，请刷新目标后重试");
        }
        mach_timebase_info_data_t clock;
        mach_timebase_info(&clock);
        if ((double)(mach_absolute_time() - began) * clock.numer / clock.denom / 1e6 >= remainingMs) {
            clearEvents(&list); return fail(env, "STALE", "按键请求已过期，请主动重试");
        }
        // System dispatch also reaches global shortcuts such as the user's dictation key.
        // Nothing awaits a network reply or timer while a modifier is down.
        for (size_t i = 0; i < list.count; ++i) {
            if (text) CGEventPostToPid((pid_t)[[expected componentsSeparatedByString:@":"][0] intValue], list.events[i]);
            else CGEventPost(kCGHIDEventTap, list.events[i]);
        }
        clearEvents(&list);
        return json(env, @{ @"posted": @YES, @"target": target, @"confirmed": @NO,
            @"targetChangedDuringPost": @(![currentTarget()[@"id"] isEqualToString:expected]) });
    }
}
static NSNetService *discoveryService;
static napi_value advertise(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1], result; int32_t port = 0;
    if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_int32(env, args[0], &port) != napi_ok || port < 0 || port > 65535)
        return fail(env, "INVALID", "发现服务端口无效");
    [discoveryService stop]; discoveryService = nil;
    if (port) {
        discoveryService = [[NSNetService alloc] initWithDomain:@"local." type:@"_nokey._tcp." name:@"NoKey" port:port];
        [discoveryService publish];
    }
    napi_get_undefined(env, &result); return result;
}
NAPI_MODULE_INIT() {
    napi_value read, send, discovery;
    if (napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, NULL, &read) != napi_ok ||
        napi_set_named_property(env, exports, "snapshot", read) != napi_ok ||
        napi_create_function(env, "press", NAPI_AUTO_LENGTH, press, NULL, &send) != napi_ok ||
        napi_set_named_property(env, exports, "press", send) != napi_ok) return fail(env, "NATIVE", "无法加载按键模块");
    if (napi_create_function(env, "advertise", NAPI_AUTO_LENGTH, advertise, NULL, &discovery) != napi_ok || napi_set_named_property(env, exports, "advertise", discovery) != napi_ok) return fail(env, "NATIVE", "无法加载本机发现");
    return exports;
}
#endif
