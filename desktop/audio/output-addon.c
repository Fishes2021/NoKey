// SPDX-License-Identifier: GPL-3.0-only
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <CoreAudio/CoreAudio.h>
#include "voice-output.h"

typedef struct { VDOutput *output; } State;
static napi_value error(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}
static void cleanup(napi_env env, void *data, void *hint) {
    (void)env; (void)hint;
    State *state = data;
    vd_output_close(state->output);
    free(state);
}
static napi_value call(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2], result;
    void *operation;
    State *state;
    if (napi_get_cb_info(env, info, &argc, args, NULL, &operation) != napi_ok ||
        napi_get_instance_data(env, (void **)&state) != napi_ok) return error(env, "Invalid native call.");
    int32_t status = 0;
    switch ((intptr_t)operation) {
    case 0: status = vd_output_probe(); break;
    case 1:
        if (state->output) return error(env, "Audio output is already open.");
        status = vd_output_open(&state->output); break;
    case 2: {
        bool typed = false;
        napi_typedarray_type type;
        size_t length, offset;
        void *samples;
        napi_value buffer;
        double gain;
        if (argc != 2 || napi_is_typedarray(env, args[0], &typed) != napi_ok || !typed ||
            napi_get_typedarray_info(env, args[0], &type, &length, &samples, &buffer, &offset) != napi_ok ||
            type != napi_float32_array || length == 0 || length % 2 || length > 9600 ||
            napi_get_value_double(env, args[1], &gain) != napi_ok)
            return error(env, "Expected stereo Float32Array and numeric gain.");
        if (!state->output) return error(env, "Audio output is not open.");
        status = vd_output_push(state->output, samples, length / 2, (float)gain);
        break;
    }
    case 3: vd_output_clear(state->output); break;
    case 4: vd_output_close(state->output); state->output = NULL; break;
    }
    napi_create_int32(env, status, &result);
    return result;
}
// Device identity is the persistent Core Audio UID, never a transient numeric ID.
static napi_value device_string(napi_env env, AudioDeviceID device, AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = { selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    CFStringRef value = NULL;
    UInt32 size = sizeof(value);
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) || !value)
        return error(env, "Cannot read microphone identity.");
    CFIndex length = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
    char *text = malloc((size_t)length);
    if (!text) { CFRelease(value); return error(env, "Cannot allocate microphone identity."); }
    Boolean ok = CFStringGetCString(value, text, length, kCFStringEncodingUTF8);
    CFRelease(value);
    napi_value result = NULL;
    if (ok) napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result);
    free(text);
    return ok ? result : error(env, "Invalid microphone identity.");
}
static bool has_input(AudioDeviceID device) {
    AudioObjectPropertyAddress address = { kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size) || size < sizeof(AudioBufferList)) return false;
    AudioBufferList *buffers = malloc(size);
    if (!buffers) return false;
    bool found = false;
    if (!AudioObjectGetPropertyData(device, &address, 0, NULL, &size, buffers))
        for (UInt32 i = 0; i < buffers->mNumberBuffers; ++i) found |= buffers->mBuffers[i].mNumberChannels > 0;
    free(buffers);
    return found;
}
static napi_value input_devices(napi_env env, napi_callback_info info) {
    (void)info;
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioDeviceID current = kAudioObjectUnknown;
    UInt32 size = sizeof(current);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &current))
        return error(env, "Cannot read default microphone.");
    address.mSelector = kAudioHardwarePropertyDevices;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size))
        return error(env, "Cannot list microphones.");
    AudioDeviceID *devices = malloc(size ? size : 1);
    if (!devices) return error(env, "Cannot allocate microphone list.");
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices)) {
        free(devices); return error(env, "Cannot list microphones.");
    }
    napi_value result; napi_create_array(env, &result);
    uint32_t index = 0;
    for (UInt32 i = 0; i < size / sizeof(*devices); ++i) {
        if (!has_input(devices[i])) continue;
        napi_value uid = device_string(env, devices[i], kAudioDevicePropertyDeviceUID);
        if (!uid) { free(devices); return NULL; }
        napi_value name = device_string(env, devices[i], kAudioObjectPropertyName);
        if (!name) { free(devices); return NULL; }
        napi_value entry, selected; napi_create_object(env, &entry);
        napi_get_boolean(env, devices[i] == current, &selected);
        napi_set_named_property(env, entry, "uid", uid);
        napi_set_named_property(env, entry, "name", name);
        napi_set_named_property(env, entry, "selected", selected);
        napi_set_element(env, result, index++, entry);
    }
    free(devices); return result;
}
static napi_value select_input(napi_env env, napi_callback_info info) {
    napi_value arg; size_t argc = 1, length = 0;
    if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_string_utf8(env, arg, NULL, 0, &length) != napi_ok || !length || length > 4096)
        return error(env, "Invalid microphone UID.");
    char text[4097];
    if (napi_get_value_string_utf8(env, arg, text, sizeof(text), &length) != napi_ok || strlen(text) != length)
        return error(env, "Invalid microphone UID.");
    CFStringRef uid = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    if (!uid) return error(env, "Invalid microphone UID.");
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioDeviceID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(uid), &uid, &size, &device);
    CFRelease(uid);
    if (status || device == kAudioObjectUnknown || !has_input(device)) return error(env, "Microphone is unavailable.");
    address.mSelector = kAudioHardwarePropertyDefaultInputDevice;
    status = AudioObjectSetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, sizeof(device), &device);
    napi_value result; napi_create_int32(env, status, &result); return result;
}
NAPI_MODULE_INIT() {
    State *state = calloc(1, sizeof(*state));
    if (!state) return error(env, "Cannot allocate audio output.");
    if (napi_set_instance_data(env, state, cleanup, NULL) != napi_ok) {
        free(state); return error(env, "Cannot initialize audio output.");
    }
    const char *names[] = { "probe", "open", "push", "clear", "close" };
    for (intptr_t i = 0; i < 5; ++i) {
        napi_value function;
        if (napi_create_function(env, names[i], NAPI_AUTO_LENGTH, call, (void *)i, &function) != napi_ok ||
            napi_set_named_property(env, exports, names[i], function) != napi_ok)
            return error(env, "Cannot export audio output.");
    }
    napi_value list, select;
    napi_create_function(env, "inputDevices", NAPI_AUTO_LENGTH, input_devices, NULL, &list);
    napi_create_function(env, "selectInput", NAPI_AUTO_LENGTH, select_input, NULL, &select);
    napi_set_named_property(env, exports, "inputDevices", list);
    napi_set_named_property(env, exports, "selectInput", select);
    return exports;
}
