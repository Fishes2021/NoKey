import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { createHeldDirection } from '../lib/held-direction.mjs';

type Direction = 'up' | 'right' | 'down' | 'left';
export function joystickDirection(x: number, y: number, deadZone: number): Direction | null {
  'worklet';
  if (Math.hypot(x, y) <= deadZone) return null;
  return Math.abs(x) > Math.abs(y) ? x > 0 ? 'right' : 'left' : y > 0 ? 'down' : 'up';
}
export function Joystick({ onDirection, labels, enabled = true, resetKey = '' }: {
  onDirection: (direction: Direction, repeat: boolean) => Promise<boolean>;
  labels: Partial<Record<Direction, string>>;
  enabled?: boolean; resetKey?: string;
}) {
  const handlers = useRef({ onDirection, enabled }); handlers.current = { onDirection, enabled };
  const repeater = useMemo(() => createHeldDirection((direction, repeat) => handlers.current.enabled && AppState.currentState === 'active'
    ? handlers.current.onDirection(direction as Direction, repeat) : Promise.resolve(false)), []);
  const x = useSharedValue(0), y = useSharedValue(0), held = useSharedValue<Direction | null>(null);
  const width = useSharedValue(100), height = useSharedValue(100);
  useEffect(() => {
    repeater.stop(); held.value = null; x.value = 0; y.value = 0;
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { repeater.stop(); held.value = null; x.value = 0; y.value = 0; } });
    return () => { repeater.stop(); subscription.remove(); };
  }, [repeater, enabled, resetKey, held, x, y]);
  const change = useCallback((direction: Direction | null) => repeater.set(direction), [repeater]);
  const capStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));
  const gesture = useMemo(() => {
    const update = (px: number, py: number) => {
      'worklet';
      const dx = px - width.value / 2, dy = py - height.value / 2;
      const limit = Math.min(width.value, height.value) * 0.15;
      const distance = Math.hypot(dx, dy), scale = distance > limit ? limit / distance : 1;
      x.value = dx * scale; y.value = dy * scale;
      const direction = joystickDirection(dx, dy, Math.min(width.value, height.value) * 0.18);
      if (direction !== held.value) { held.value = direction; runOnJS(change)(direction); }
    };
    return Gesture.Pan().enabled(enabled).minDistance(0).maxPointers(1).shouldCancelWhenOutside(false)
      .onStart(event => { update(event.x, event.y); })
      .onUpdate(event => { update(event.x, event.y); })
      .onFinalize(() => {
        held.value = null; runOnJS(change)(null);
        x.value = withSpring(0, { damping: 16, stiffness: 250 }); y.value = withSpring(0, { damping: 16, stiffness: 250 });
      });
  }, [enabled, change, held, width, height, x, y]);
  return <GestureDetector gesture={gesture}>
    <View collapsable={false} style={styles.module}
      onLayout={event => { width.value = event.nativeEvent.layout.width; height.value = event.nativeEvent.layout.height; }}
      accessible accessibilityRole="adjustable" accessibilityLabel="四向光标摇杆" accessibilityState={{ disabled: !enabled }}
      accessibilityHint="点按移动一次，按住方向连续移动，松手停止。自定义请进入设置。"
      accessibilityActions={(['up', 'right', 'down', 'left'] as const).map((direction, index) => ({ name: direction, label: `${['上', '右', '下', '左'][index]}：${labels[direction] || '移动光标'}` }))}
      onAccessibilityAction={event => { if (enabled && ['up', 'right', 'down', 'left'].includes(event.nativeEvent.actionName)) void onDirection(event.nativeEvent.actionName as Direction, false); }}>
      <View pointerEvents="none" style={styles.socket} />
      <Animated.View pointerEvents="none" style={[styles.cap, capStyle]}><View style={styles.thumb} /></Animated.View>
      {(['up', 'right', 'down', 'left'] as const).map((direction, index) => <Text pointerEvents="none" key={direction}
        numberOfLines={1} style={[styles.label, styles[direction]]}>{labels[direction] || ['上', '右', '下', '左'][index]}</Text>)}
    </View>
  </GestureDetector>;
}
const styles = StyleSheet.create({
  module: { flex: 1, width: '100%', height: '100%', backgroundColor: '#F8F7F3', borderRadius: 16,
    borderWidth: 1, borderColor: '#EEEDE7', alignItems: 'center', justifyContent: 'center' },
  socket: { position: 'absolute', width: '64%', aspectRatio: 1, borderRadius: 100,
    backgroundColor: '#DAD8CF', borderWidth: 3, borderTopColor: '#C7C5BB', borderLeftColor: '#D1CFC5', borderRightColor: '#EAE8E0', borderBottomColor: '#F2F0E9' },
  cap: { width: '48%', aspectRatio: 1, borderRadius: 100, padding: 4, backgroundColor: '#EEECE4',
    borderWidth: 1, borderTopColor: '#FFFFFF', borderLeftColor: '#FAF9F4', borderRightColor: '#C7C4B9', borderBottomColor: '#B8B5AB',
    shadowColor: '#4C4A40', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.24, shadowRadius: 3 },
  thumb: { flex: 1, borderRadius: 100, backgroundColor: '#F4F2EB', borderWidth: 1,
    borderTopColor: '#DEDBD1', borderLeftColor: '#E5E2D9', borderRightColor: '#FFFDF7', borderBottomColor: '#FFFFFF' },
  label: { position: 'absolute', color: '#74776B', fontSize: 9, textAlign: 'center', maxWidth: '38%' },
  up: { top: 3 }, down: { bottom: 3 }, left: { left: 3 }, right: { right: 3 },
});
