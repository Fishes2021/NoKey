// SPDX-License-Identifier: GPL-3.0-only
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct VDOutput VDOutput;
// All input is decoded, interleaved stereo float32 PCM at 48 kHz.
// The media receiver owns authentication, decoding and network jitter handling.
// Lifecycle calls must not race with push/clear. No default device is changed.
int32_t vd_output_probe(void);
int32_t vd_output_open(VDOutput **output);
int32_t vd_output_push(VDOutput *output, const float *samples, size_t frames, float gain);
void vd_output_clear(VDOutput *output);
void vd_output_close(VDOutput *output);
