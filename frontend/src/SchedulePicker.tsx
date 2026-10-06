import { useState } from "react";
import type { ChangeEvent } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

type Kind = "date" | "time";

interface Props {
  kind: Kind;
  label: string;
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
  min?: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function SchedulePicker({ kind, label, value, onChange, isDark, min }: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date());
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const foreground = isDark ? "#F3F0FF" : "#1E1A29";
  const subdued = isDark ? "#A09AAB" : "#645E73";
  const surface = isDark ? "#120E1C" : "#F5F3F9";
  const border = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.13)";

  if (Platform.OS === "web") {
    return (
      <View style={{ flex: 1, minWidth: 135 }}>
        <Text style={{ color: subdued, fontSize: 12, marginBottom: 7 }}>{label}</Text>
        <input
          aria-label={label}
          type={kind}
          value={value}
          min={min}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          style={{ width: "100%", boxSizing: "border-box", minHeight: 48, padding: "10px 12px", borderRadius: 10, border: `1px solid ${border}`, background: surface, color: foreground, colorScheme: isDark ? "dark" : "light", font: "inherit", fontSize: 14, cursor: "pointer" }}
        />
      </View>
    );
  }

  const openPicker = () => {
    if (kind === "date") {
      const selected = value ? new Date(`${value}T12:00:00`) : new Date();
      setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    } else {
      const [h, m] = value.split(":").map(Number);
      setHour(h !== undefined && Number.isFinite(h) ? h : 9);
      setMinute(m !== undefined && Number.isFinite(m) ? m : 0);
    }
    setOpen(true);
  };
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leadingDays = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const calendarDays = Array.from({ length: leadingDays + daysInMonth }, (_, index) => index - leadingDays + 1);
  const timeColumns = [
    { heading: "Hour", values: Array.from({ length: 24 }, (_, index) => index), selected: hour, choose: setHour },
    { heading: "Minute", values: Array.from({ length: 60 }, (_, index) => index), selected: minute, choose: setMinute },
  ];

  return (
    <View style={{ flex: 1, minWidth: 135 }}>
      <Text style={{ color: subdued, fontSize: 12, marginBottom: 7 }}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${label.toLowerCase()}`} onPress={openPicker} style={{ minHeight: 48, paddingHorizontal: 12, borderRadius: 10, backgroundColor: surface, borderWidth: 1, borderColor: border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: value ? foreground : subdued, fontSize: 14 }}>{value || `Select ${kind}`}</Text>
        <Feather name={kind === "date" ? "calendar" : "clock"} size={17} color="#A78BFA" />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.68)", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <View style={{ width: "100%", maxWidth: 370, borderRadius: 18, padding: 20, backgroundColor: isDark ? "#211B30" : "#FFFFFF" }}>
            <Text style={{ color: foreground, fontSize: 18, fontWeight: "700", marginBottom: 18 }}>{label}</Text>
            {kind === "date" ? <>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} accessibilityLabel="Previous month"><Feather name="chevron-left" size={22} color="#A78BFA" /></Pressable>
                <Text style={{ color: foreground, fontWeight: "700" }}>{month.toLocaleString(undefined, { month: "long", year: "numeric" })}</Text>
                <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} accessibilityLabel="Next month"><Feather name="chevron-right" size={22} color="#A78BFA" /></Pressable>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <Text key={index} style={{ width: "14.28%", textAlign: "center", color: subdued, marginBottom: 8 }}>{day}</Text>)}
                {calendarDays.map((day, index) => {
                  const date = day > 0 ? `${month.getFullYear()}-${pad(month.getMonth() + 1)}-${pad(day)}` : "";
                  const disabled = !date || Boolean(min && date < min);
                  return <Pressable key={index} disabled={disabled} onPress={() => { onChange(date); setOpen(false); }} style={{ width: "14.28%", height: 42, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: date === value ? "#755BD0" : "transparent", opacity: disabled ? 0.3 : 1 }}><Text style={{ color: date === value ? "white" : foreground }}>{day > 0 ? day : ""}</Text></Pressable>;
                })}
              </View>
            </> : <>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {timeColumns.map(({ values, selected, choose, heading }) => <View key={heading} style={{ flex: 1 }}><Text style={{ color: subdued, textAlign: "center", marginBottom: 8 }}>{heading}</Text><ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>{values.map((number) => <Pressable key={number} onPress={() => choose(number)} style={{ paddingVertical: 8, borderRadius: 8, backgroundColor: selected === number ? "#755BD0" : "transparent" }}><Text style={{ textAlign: "center", color: selected === number ? "white" : foreground }}>{pad(number)}</Text></Pressable>)}</ScrollView></View>)}
              </View>
              <Pressable onPress={() => { onChange(`${pad(hour)}:${pad(minute)}`); setOpen(false); }} style={{ marginTop: 18, padding: 12, borderRadius: 9, backgroundColor: "#755BD0", alignItems: "center" }}><Text style={{ color: "white", fontWeight: "700" }}>Set time</Text></Pressable>
            </>}
            <Pressable onPress={() => setOpen(false)} style={{ marginTop: 16, alignItems: "center" }}><Text style={{ color: subdued }}>Cancel</Text></Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export function todayLocal() {
  return localDate(new Date());
}
