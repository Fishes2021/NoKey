import { requireOptionalNativeModule } from 'expo';
import type { NativeAudioGate } from '../../lib/phone-audio-capture.mjs';

// Imported only on an explicit iPhone start action; never fall back to unguarded capture.
const nativeAudio = requireOptionalNativeModule<NativeAudioGate>('VoiceDeckAudio');
if (!nativeAudio) throw new Error('当前安装包缺少麦克风中断组件，请安装包含该组件的新版本');
const audioGate: NativeAudioGate = nativeAudio;
export default audioGate;
