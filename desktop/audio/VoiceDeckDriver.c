// SPDX-License-Identifier: GPL-3.0-only
// Compile the upstream driver with our own device identity; keep its audio engine intact.
#define kDriver_Name "VoiceDeckMicrophone"
#define kHas_Driver_Name_Format 0
#define kDevice_Name "语音快捷键盘麦克风"
#define kPlugIn_BundleID "org.voicedeck.microphone"
#define kPlugIn_Icon ""
#define kNumber_Of_Channels 2
#include "../../vendor/BlackHole/BlackHole/BlackHole.c"
