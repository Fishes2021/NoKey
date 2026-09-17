// SPDX-License-Identifier: GPL-3.0-only
#include "voice-output.h"
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreServices/CoreServices.h>
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { VD_RATE = 48000, VD_CHANNELS = 2, VD_CAPACITY = 4800 };
static const uint64_t VD_MAX_AGE = 100000000; // 100 ms; never accumulate a recording.
struct VDOutput {
    AudioUnit unit;
    pthread_mutex_t mutex;
    float samples[VD_CAPACITY * VD_CHANNELS];
    uint64_t received[VD_CAPACITY];
    size_t read, count;
};

static uint64_t now_ns(void) {
    return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
}

static OSStatus find_device(AudioDeviceID *device) {
    CFStringRef uid = CFSTR("VoiceDeckMicrophone_UID");
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyTranslateUIDToDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    UInt32 size = sizeof(*device);
    *device = kAudioObjectUnknown;
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address,
        sizeof(uid), &uid, &size, device);
    return status ? status : (*device == kAudioObjectUnknown ? kAudioHardwareBadDeviceError : noErr);
}

int32_t vd_output_probe(void) {
    AudioDeviceID device;
    return find_device(&device);
}

static int32_t push_at(VDOutput *out, const float *samples, size_t frames, float gain, uint64_t now) {
    if (!out || !samples || frames == 0 || frames > VD_CAPACITY ||
        !isfinite(gain) || gain < 0 || gain > 4) return paramErr;
    // Validate the entire block before changing the queue.
    for (size_t i = 0; i < frames * VD_CHANNELS; ++i)
        if (!isfinite(samples[i])) return paramErr;
    pthread_mutex_lock(&out->mutex);
    if (out->count + frames > VD_CAPACITY) {
        size_t drop = out->count + frames - VD_CAPACITY;
        out->read = (out->read + drop) % VD_CAPACITY;
        out->count -= drop;
    }
    for (size_t i = 0; i < frames; ++i) {
        size_t slot = (out->read + out->count + i) % VD_CAPACITY;
        out->received[slot] = now;
        for (size_t ch = 0; ch < VD_CHANNELS; ++ch)
            out->samples[slot * VD_CHANNELS + ch] =
                fmaxf(-1, fminf(1, samples[i * VD_CHANNELS + ch] * gain));
    }
    out->count += frames;
    pthread_mutex_unlock(&out->mutex);
    return noErr;
}

int32_t vd_output_push(VDOutput *out, const float *samples, size_t frames, float gain) {
    return push_at(out, samples, frames, gain, now_ns());
}

static void pull_at(VDOutput *out, float *samples, size_t frames, uint64_t now) {
    memset(samples, 0, frames * VD_CHANNELS * sizeof(float));
    // Audio callback never blocks behind a producer or allocates memory.
    if (pthread_mutex_trylock(&out->mutex) != 0) return;
    while (out->count && now - out->received[out->read] >= VD_MAX_AGE) {
        out->read = (out->read + 1) % VD_CAPACITY;
        --out->count;
    }
    size_t take = frames < out->count ? frames : out->count;
    for (size_t i = 0; i < take; ++i) {
        size_t slot = (out->read + i) % VD_CAPACITY;
        memcpy(samples + i * VD_CHANNELS, out->samples + slot * VD_CHANNELS,
            VD_CHANNELS * sizeof(float));
    }
    out->read = (out->read + take) % VD_CAPACITY;
    out->count -= take;
    pthread_mutex_unlock(&out->mutex);
}

static OSStatus render(void *context, AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *time, UInt32 bus, UInt32 frames, AudioBufferList *data) {
    (void)flags; (void)time; (void)bus;
    if (!data || data->mNumberBuffers != 1 || !data->mBuffers[0].mData ||
        data->mBuffers[0].mNumberChannels != VD_CHANNELS ||
        data->mBuffers[0].mDataByteSize < (uint64_t)frames * VD_CHANNELS * sizeof(float)) {
        if (data) for (UInt32 i = 0; i < data->mNumberBuffers; ++i)
            if (data->mBuffers[i].mData) memset(data->mBuffers[i].mData, 0, data->mBuffers[i].mDataByteSize);
        return kAudioUnitErr_FormatNotSupported;
    }
    pull_at(context, data->mBuffers[0].mData, frames, now_ns());
    return noErr;
}

void vd_output_clear(VDOutput *out) {
    if (!out) return;
    pthread_mutex_lock(&out->mutex);
    out->read = out->count = 0;
    pthread_mutex_unlock(&out->mutex);
}

void vd_output_close(VDOutput *out) {
    if (!out) return;
    if (out->unit) {
        AudioOutputUnitStop(out->unit);
        AudioUnitUninitialize(out->unit);
        AudioComponentInstanceDispose(out->unit);
    }
    pthread_mutex_destroy(&out->mutex);
    free(out);
}

int32_t vd_output_open(VDOutput **result) {
    if (!result) return paramErr;
    *result = NULL;
    AudioDeviceID device;
    OSStatus status = find_device(&device);
    if (status) return status; // Never fall back to speakers or another BlackHole device.
    VDOutput *out = calloc(1, sizeof(*out));
    if (!out) return memFullErr;
    if (pthread_mutex_init(&out->mutex, NULL)) { free(out); return memFullErr; }
    AudioComponentDescription desc = { kAudioUnitType_Output, kAudioUnitSubType_HALOutput,
        kAudioUnitManufacturer_Apple, 0, 0 };
    AudioComponent component = AudioComponentFindNext(NULL, &desc);
    if (!component) { vd_output_close(out); return kAudioUnitErr_InvalidProperty; }
    status = AudioComponentInstanceNew(component, &out->unit);
    UInt32 enabled = 1, disabled = 0;
    if (!status) status = AudioUnitSetProperty(out->unit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output, 0, &enabled, sizeof(enabled));
    if (!status) status = AudioUnitSetProperty(out->unit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input, 1, &disabled, sizeof(disabled));
    if (!status) status = AudioUnitSetProperty(out->unit, kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0, &device, sizeof(device));
    AudioStreamBasicDescription format = { .mSampleRate = VD_RATE,
        .mFormatID = kAudioFormatLinearPCM, .mFormatFlags = kAudioFormatFlagsNativeFloatPacked,
        .mBytesPerPacket = 8, .mFramesPerPacket = 1, .mBytesPerFrame = 8,
        .mChannelsPerFrame = VD_CHANNELS, .mBitsPerChannel = 32 };
    if (!status) status = AudioUnitSetProperty(out->unit, kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Input, 0, &format, sizeof(format));
    AURenderCallbackStruct callback = { render, out };
    if (!status) status = AudioUnitSetProperty(out->unit, kAudioUnitProperty_SetRenderCallback,
        kAudioUnitScope_Input, 0, &callback, sizeof(callback));
    if (!status) status = AudioUnitInitialize(out->unit);
    if (!status) status = AudioOutputUnitStart(out->unit);
    if (status) { vd_output_close(out); return status; }
    *result = out;
    return noErr;
}

#ifdef VD_OUTPUT_CHECK
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
        OSStatus status = vd_output_probe();
        printf("{\"deviceUID\":\"VoiceDeckMicrophone_UID\",\"available\":%s,\"status\":%d}\n",
            status ? "false" : "true", (int)status);
        return status ? 2 : 0;
    }
    VDOutput *out = calloc(1, sizeof(*out));
    assert(out && pthread_mutex_init(&out->mutex, NULL) == 0);
    float input[VD_CAPACITY * 2], output[VD_CAPACITY * 2];
    for (size_t i = 0; i < VD_CAPACITY; ++i) {
        input[i * 2] = (float)i / VD_CAPACITY;
        input[i * 2 + 1] = -input[i * 2];
    }
    assert(push_at(out, input, VD_CAPACITY, 1, 1) == 0);
    pull_at(out, output, 3000, 2);
    assert(memcmp(input, output, 3000 * 8) == 0);
    assert(push_at(out, input, 4000, 1, 3) == 0); // overflow, then wraparound
    pull_at(out, output, VD_CAPACITY, 4);
    assert(memcmp(input + 4000 * 2, output, 800 * 8) == 0);
    assert(memcmp(input, output + 800 * 2, 4000 * 8) == 0);
    assert(push_at(out, input, 10, 1, 5) == 0);
    assert(push_at(out, input, 10, 1, VD_MAX_AGE + 6) == 0);
    pull_at(out, output, 20, VD_MAX_AGE + 7);
    assert(memcmp(input, output, 10 * 8) == 0); // expired block discarded, fresh block retained
    for (int i = 20; i < 40; ++i) assert(output[i] == 0);
    float bad[] = { NAN, 0 };
    assert(vd_output_push(out, bad, 1, 1) == paramErr && out->count == 0);
    assert(vd_output_push(out, input, VD_CAPACITY + 1, 1) == paramErr);
    assert(vd_output_push(out, input, 1, INFINITY) == paramErr);
    float loud[] = { 0.75f, -0.75f };
    assert(push_at(out, loud, 1, 2, 1) == 0);
    pull_at(out, output, 1, 2);
    assert(output[0] == 1 && output[1] == -1);
    assert(push_at(out, input, 10, 1, 1) == 0);
    vd_output_clear(out);
    pull_at(out, output, 10, 2);
    for (int i = 0; i < 20; ++i) assert(output[i] == 0);
    pthread_mutex_lock(&out->mutex);
    pull_at(out, output, 10, 2); // contended producer cannot block audio callback
    pthread_mutex_unlock(&out->mutex);
    for (int i = 0; i < 20; ++i) assert(output[i] == 0);
    vd_output_close(out);
    puts("voice-output: PCM, wraparound, bounded backlog, stale discard, gain, validation, clear and contention passed");
    return 0;
}
#endif
