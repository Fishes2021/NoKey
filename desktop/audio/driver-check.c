// SPDX-License-Identifier: GPL-3.0-only
// Exercise our actual configured driver without installing it into CoreAudio.
#include <assert.h>
#include "VoiceDeckDriver.c"

int main(void) {
    CFStringRef uid = get_device_uid();
    assert(CFEqual(uid, CFSTR("VoiceDeckMicrophone_UID")));
    CFRelease(uid);
    assert(kDevice_HasInput && kDevice_HasOutput);
    gRingBuffer = calloc(kRing_Buffer_Frame_Size * kNumber_Of_Channels, sizeof(Float32));
    assert(gRingBuffer);
    Float32 sent[16], received[16];
    for (int i = 0; i < 16; ++i) sent[i] = (i - 8) / 16.0f;
    // Check both a normal block and a block crossing the circular-buffer boundary.
    UInt64 positions[] = {100, kRing_Buffer_Frame_Size - 4};
    for (int n = 0; n < 2; ++n) {
        AudioServerPlugInIOCycleInfo cycle = {0};
        cycle.mOutputTime.mSampleTime = positions[n];
        cycle.mInputTime.mSampleTime = positions[n];
        assert(!BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
            kObjectID_Stream_Output, 0, kAudioServerPlugInIOOperationWriteMix,
            8, &cycle, sent, NULL));
        assert(!BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
            kObjectID_Stream_Input, 0, kAudioServerPlugInIOOperationReadInput,
            8, &cycle, received, NULL));
        assert(!memcmp(sent, received, sizeof(sent)));
        // No fresh sender audio must yield silence, not replay an old sentence.
        cycle.mInputTime.mSampleTime += 8;
        assert(!BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
            kObjectID_Stream_Input, 0, kAudioServerPlugInIOOperationReadInput,
            8, &cycle, received, NULL));
        for (int i = 0; i < 16; ++i) assert(received[i] == 0);
    }
    free(gRingBuffer);
    puts("Driver check passed: identity, PCM loopback, wraparound, silence.");
}
