// Palette shared by the sign-in and admin screens; mirrors the tokens in App.tsx.
export function authPalette(isDark: boolean) {
  return isDark ? {
    bg: "#100E14", header: "rgba(16,14,20,0.92)", surface: "#1A181E", raised: "#25222B",
    border: "#302C38", strongBorder: "#4B4262", text: "#F5F2FA", body: "#D0CBD9",
    muted: "#ABA4B9", purpleText: "#D8CDF8", purpleSurface: "#282231", accent: "#755BD0",
    success: "#34D399", successSurface: "rgba(52,211,153,0.12)", danger: "#FB7185",
    dangerSurface: "rgba(251,113,133,0.12)", glow: "rgba(100,70,170,0.14)",
  } : {
    bg: "#F7F4FB", header: "rgba(255,255,255,0.94)", surface: "#FFFFFF", raised: "#EEE9F4",
    border: "#DDD6E6", strongBorder: "#C4B5D8", text: "#241D2D", body: "#51475E",
    muted: "#6E637B", purpleText: "#62499A", purpleSurface: "#EEE7F8", accent: "#755BD0",
    success: "#0F8A5F", successSurface: "rgba(16,185,129,0.12)", danger: "#C0264A",
    dangerSurface: "rgba(225,29,72,0.10)", glow: "rgba(132,94,210,0.14)",
  };
}

export type AuthPalette = ReturnType<typeof authPalette>;
