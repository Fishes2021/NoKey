import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ComponentProps, ReactNode, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSkeuo } from '@/components/skeuo';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

type HardwareKeyProps = {
  accessibilityLabel: string;
  icon?: IconName;
  symbol?: ReactNode;
  caption?: string;
  /** `rgb` = translucent task key with bloom. `command` = solid white icon key. */
  variant?: 'command' | 'rgb';
  /** Override bloom color (Agent Key status). Defaults to Codex blue. */
  glowColor?: string;
  /** Stronger bloom / selected agent key. */
  selected?: boolean;
  /** A restrained inner latch ring, used by hardware toggles such as Fast. */
  latchedColor?: string;
  active?: boolean;
  flatTint?: boolean;
  disabled?: boolean;
  unavailableReason?: string;
  /** 0–1 offset in the backlight cycle, so lit keys ripple instead of blinking together. */
  phase?: number;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onDoublePress?: () => void;
  onLongPress?: () => void;
};

const GLOW_CYCLE = 2000;

export function HardwareKey({
  accessibilityLabel,
  icon,
  symbol,
  caption,
  variant = 'command',
  glowColor,
  selected = false,
  latchedColor,
  active = false,
  flatTint = false,
  disabled = false,
  unavailableReason,
  phase = 0,
  onPress,
  onPressIn,
  onPressOut,
  onDoublePress,
  onLongPress,
}: HardwareKeyProps) {
  const skeuo = useSkeuo();
  const iconColor = active ? '#356B53' : skeuo.icon;
  const emptySymbol = symbol === null;
  const lastReleaseAt = useRef(0);
  const doublePress = useRef(false);
  const hasPressLifecycle = Boolean(onPressIn || onPressOut || onDoublePress);

  const handlePressIn = () => {
    const now = Date.now();
    const isDoublePress = Boolean(
      onDoublePress && lastReleaseAt.current && now - lastReleaseAt.current <= 350,
    );
    doublePress.current = isDoublePress;
    if (isDoublePress) onDoublePress?.();
    else onPressIn?.();
  };

  const handlePressOut = () => {
    if (!doublePress.current) onPressOut?.();
    lastReleaseAt.current = Date.now();
  };

  const handlePress = () => {
    if (!hasPressLifecycle) onPress?.();
    doublePress.current = false;
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={unavailableReason}
      accessibilityState={{ selected: active || selected, disabled }}
      disabled={disabled}
      onPress={handlePress}
      onPressIn={hasPressLifecycle ? handlePressIn : undefined}
      onPressOut={hasPressLifecycle ? handlePressOut : undefined}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.shell,
        disabled && styles.disabled,
        unavailableReason && styles.unavailable,
        pressed && styles.pressed,

      ]}>
      <View style={[styles.cap, { backgroundColor: active || selected ? '#E8F0E9' : '#FFFFFF', borderRadius: 15, alignItems: 'center', justifyContent: 'center' }]}>
        {!emptySymbol ? (
          <View style={[styles.symbol, caption ? styles.symbolWithCaption : null]}>
            {symbol ?? (
              <MaterialCommunityIcons
                name={icon ?? 'circle-outline'}
                size={caption ? 25 : 28}
                color={iconColor}
              />
            )}
            {caption ? (
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.58}
                numberOfLines={1}
                style={[styles.caption, { color: skeuo.label }]}>
                {caption}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    width: '100%',
    height: '100%',
    padding: 0,
  },
  selectedShell: {
    transform: [{ scale: 1.03 }],
  },
  cap: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  symbol: {
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  symbolWithCaption: {
    alignSelf: 'stretch',
    gap: 2,
    paddingHorizontal: 2,
  },
  caption: {
    width: '100%',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    textAlign: 'center',
  },
  pressed: {
    transform: [{ translateY: 2 }, { scale: 0.97 }],
  },
  disabled: { opacity: 0.45 },
  unavailable: { opacity: 0.62 },
});
