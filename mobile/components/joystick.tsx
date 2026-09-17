import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

type Direction = 'up' | 'right' | 'down' | 'left';
export function joystickDirection(x: number, y: number, deadZone: number): Direction | null {
  'worklet';
  if (Math.hypot(x, y) <= deadZone) return null;
  return Math.abs(x) > Math.abs(y) ? x > 0 ? 'right' : 'left' : y > 0 ? 'down' : 'up';
}

export function Joystick({ onDirection, onConfigure, labels }: {
  onDirection: (direction: Direction) => void;
  onConfigure: (direction: Direction) => void;
  labels: Partial<Record<Direction, string>>;
}) {
  const handlers = useRef({ onDirection, onConfigure });
  handlers.current = { onDirection, onConfigure };
  const commit = useCallback((direction: Direction) => handlers.current.onDirection(direction), []);
  const configure = useCallback((direction: Direction) => handlers.current.onConfigure(direction), []);
  const x = useSharedValue(0), y = useSharedValue(0);
  const width = useSharedValue(100), height = useSharedValue(100);
  const capStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));
  const gesture = useMemo(() => {
    const pan = Gesture.Pan().minDistance(6).maxPointers(1).shouldCancelWhenOutside(false)
      .onUpdate(event => {
        const limit = Math.min(width.value, height.value) * 0.15;
        const distance = Math.hypot(event.translationX, event.translationY);
        const scale = distance > limit ? limit / distance : 1;
        x.value = event.translationX * scale; y.value = event.translationY * scale;
      })
      .onEnd(event => {
        const direction = joystickDirection(event.translationX, event.translationY, 6);
        if (direction) runOnJS(commit)(direction);
      })
      .onFinalize(() => {
        x.value = withSpring(0, { damping: 16, stiffness: 250 });
        y.value = withSpring(0, { damping: 16, stiffness: 250 });
      });
    const tap = Gesture.Tap().maxDistance(6).onEnd((event, success) => {
      if (!success) return;
      const direction = joystickDirection(event.x - width.value / 2, event.y - height.value / 2, Math.min(width.value, height.value) * 0.18);
      if (direction) runOnJS(commit)(direction);
    });
    const hold = Gesture.LongPress().minDuration(500).maxDistance(6).onStart(event => {
      const direction = joystickDirection(event.x - width.value / 2, event.y - height.value / 2, 0) || 'up';
      runOnJS(configure)(direction);
    });
    return Gesture.Race(pan, Gesture.Exclusive(hold, tap));
  }, [commit, configure, width, height, x, y]);
  return <GestureDetector gesture={gesture}>
    <View collapsable={false} style={styles.module}
      onLayout={event => { width.value = event.nativeEvent.layout.width; height.value = event.nativeEvent.layout.height; }}
      accessible accessibilityRole="adjustable" accessibilityLabel="四向自定义摇杆"
      accessibilityHint="点按边缘或向对应方向拖动后松手执行；长按配置快捷键。"
      accessibilityActions={[
        ...(['up', 'right', 'down', 'left'] as const).map((direction, index) => ({ name: direction, label: `${['上', '右', '下', '左'][index]}：${labels[direction] || '未设置'}` })),
        { name: 'configure', label: '设置摇杆快捷键' },
      ]}
      onAccessibilityAction={event => {
        const action = event.nativeEvent.actionName;
        if (action === 'configure') configure('up');
        else if (['up', 'right', 'down', 'left'].includes(action)) commit(action as Direction);
      }}>
      <View pointerEvents="none" style={styles.socket} />
      <Animated.View pointerEvents="none" style={[styles.cap, capStyle]}><View style={styles.thumb} /></Animated.View>
      {(['up', 'right', 'down', 'left'] as const).map(direction => <Text pointerEvents="none" key={direction}
        numberOfLines={1} style={[styles.label, styles[direction]]}>{labels[direction] || (direction === 'up' || direction === 'down' ? '│' : '─')}</Text>)}
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
