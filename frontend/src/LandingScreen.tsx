import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

const features = [
  { icon: "mic" as const, title: "Record", text: "Capture speech and review the original transcript. Translate to Tamil when needed." },
  { icon: "radio" as const, title: "Live", text: "Follow spoken words and Tamil translation as a conversation unfolds." },
  { icon: "upload-cloud" as const, title: "Upload", text: "Turn an existing audio file into a transcript you can revisit." },
];

export default function LandingScreen({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroll = useRef<ScrollView>(null);
  const positions = useRef<Record<string, number>>({ home: 0 });
  const { width } = useWindowDimensions();
  const compact = width < 700;
  const go = (section: string) => scroll.current?.scrollTo({ y: positions.current[section] ?? 0, animated: true });
  return (
    <ScrollView ref={scroll} style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <LinearGradient colors={["#A78BFA", "#6D5CE7"]} style={styles.logo}><MaterialCommunityIcons name="waveform" size={23} color="white" /></LinearGradient>
          <Text style={styles.brandName}>VoxLive</Text>
        </View>
        {!compact && <View style={styles.navigation}>{([["Home", "home"], ["Features", "features"], ["How it works", "how"], ["About", "about"]] as const).map(([label, section]) => <Pressable key={section} accessibilityRole="button" onPress={() => go(section)}><Text style={styles.navText}>{label}</Text></Pressable>)}</View>}
        <View style={styles.headerActions}><Pressable accessibilityRole="button" onPress={onSignIn}><Text style={styles.navText}>Log in</Text></Pressable><Pressable accessibilityRole="button" onPress={onRegister} style={styles.smallButton}><Text style={styles.buttonText}>Get started</Text></Pressable></View>
      </View>
      {compact && <View style={styles.mobileNav}>{([["Features", "features"], ["How it works", "how"], ["About", "about"]] as const).map(([label, section]) => <Pressable key={section} accessibilityRole="button" onPress={() => go(section)}><Text style={styles.navText}>{label}</Text></Pressable>)}</View>}
      <View style={[styles.hero, compact && styles.heroCompact]}>
        <Text style={styles.eyebrow}>CONVERSATIONS, CONNECTED</Text>
        <Text style={[styles.headline, compact && styles.headlineCompact]}>Turn Every Voice Into Understanding — Live.</Text>
        <Text style={styles.intro}>Capture speech, create transcripts, and make multilingual conversations easier with Tamil translation.</Text>
        <View style={styles.actions}><Pressable accessibilityRole="button" onPress={onRegister} style={styles.primary}><Text style={styles.buttonText}>Get started  →</Text></Pressable><Pressable accessibilityRole="button" onPress={() => go("features")} style={styles.secondary}><Text style={styles.secondaryText}>Explore features</Text></Pressable></View>
      </View>
      <View onLayout={e => { positions.current.features = e.nativeEvent.layout.y; }} style={styles.section}>
        <Text style={styles.eyebrow}>THREE WAYS TO GET STARTED</Text><Text style={styles.sectionTitle}>Your words, your workflow.</Text>
        <View style={styles.cards}>{features.map(item => <View key={item.title} style={[styles.card, compact && styles.cardCompact]}><View style={styles.icon}><Feather name={item.icon} size={21} color="#C3B1FF" /></View><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.cardText}>{item.text}</Text></View>)}</View>
      </View>
      <View onLayout={e => { positions.current.how = e.nativeEvent.layout.y; }} style={styles.section}>
        <Text style={styles.eyebrow}>HOW IT WORKS</Text><Text style={styles.sectionTitle}>From speech to shared understanding.</Text>
        <View style={styles.cards}>{[["01", "Sign in", "Access your organizer account."], ["02", "Choose a workflow", "Record, stream live, or upload audio."], ["03", "Share and revisit", "Invite attendees where available and find saved results in history."]].map(([number, title, text]) => <View key={number} style={[styles.card, compact && styles.cardCompact]}><Text style={styles.stepNumber}>{number}</Text><Text style={styles.cardTitle}>{title}</Text><Text style={styles.cardText}>{text}</Text></View>)}</View>
      </View>
      <View onLayout={e => { positions.current.about = e.nativeEvent.layout.y; }} style={styles.about}><Text style={styles.eyebrow}>ABOUT VOXLIVE</Text><Text style={styles.sectionTitle}>Make room for every voice.</Text><Text style={styles.intro}>Built for meetings, presentations and multilingual discussions, VoxLive brings spoken conversations into a readable space.</Text><Pressable accessibilityRole="button" onPress={onRegister} style={styles.primary}><Text style={styles.buttonText}>Get started  →</Text></Pressable></View>
      <View style={styles.footer}><Text style={styles.brandName}>VoxLive</Text><Text style={styles.cardText}>Turn every voice into words — live.</Text><Pressable accessibilityRole="button" onPress={onSignIn}><Text style={styles.navText}>Organizer login</Text></Pressable></View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#100E16" }, content: { paddingHorizontal: 24, paddingBottom: 40 },
  header: { width: "100%", maxWidth: 1240, alignSelf: "center", minHeight: 84, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 }, logo: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" }, brandName: { color: "#F4F0FF", fontSize: 20, fontFamily: "DMSans_700Bold" },
  navigation: { flexDirection: "row", alignItems: "center", gap: 24 }, mobileNav: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 15 }, headerActions: { flexDirection: "row", alignItems: "center", gap: 16 }, navText: { color: "#C9C1D8", fontFamily: "DMSans_600SemiBold", fontSize: 13 },
  smallButton: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12, backgroundColor: "#7259D6" }, buttonText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 14 },
  hero: { width: "100%", maxWidth: 1240, alignSelf: "center", paddingVertical: 115, paddingHorizontal: 8 }, heroCompact: { paddingVertical: 65 }, eyebrow: { color: "#B59DFD", fontFamily: "DMSans_700Bold", letterSpacing: 1.6, fontSize: 11 },
  headline: { color: "#F5F1FF", fontFamily: "DMSans_700Bold", fontSize: 60, lineHeight: 68, letterSpacing: -2, maxWidth: 820, marginTop: 20 }, headlineCompact: { fontSize: 38, lineHeight: 46, letterSpacing: -1 }, intro: { color: "#B9B1C9", fontFamily: "DMSans_400Regular", fontSize: 17, lineHeight: 27, maxWidth: 630, marginTop: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 30 }, primary: { alignSelf: "flex-start", backgroundColor: "#765DE0", paddingHorizontal: 22, paddingVertical: 15, borderRadius: 13 }, secondary: { paddingHorizontal: 22, paddingVertical: 15, borderRadius: 13, borderWidth: 1, borderColor: "#55466C" }, secondaryText: { color: "#E0D6F5", fontFamily: "DMSans_600SemiBold", fontSize: 14 },
  section: { width: "100%", maxWidth: 1240, alignSelf: "center", paddingVertical: 48 }, sectionTitle: { color: "#F2EDFC", fontFamily: "DMSans_700Bold", fontSize: 30, lineHeight: 38, marginTop: 12, marginBottom: 20 }, cards: { flexDirection: "row", flexWrap: "wrap", gap: 14 }, card: { flexGrow: 1, flexBasis: 250, backgroundColor: "#1B1726", borderWidth: 1, borderColor: "#342B43", borderRadius: 20, padding: 24, minHeight: 172 }, cardCompact: { flexBasis: "100%" }, icon: { width: 43, height: 43, borderRadius: 13, backgroundColor: "#302446", alignItems: "center", justifyContent: "center", marginBottom: 18 }, cardTitle: { color: "#F2EDFC", fontFamily: "DMSans_700Bold", fontSize: 18, marginBottom: 8 }, cardText: { color: "#ADA4BD", fontFamily: "DMSans_400Regular", fontSize: 14, lineHeight: 22 }, stepNumber: { color: "#B59DFD", fontFamily: "DMSans_700Bold", fontSize: 15, marginBottom: 18 },
  about: { width: "100%", maxWidth: 1240, alignSelf: "center", padding: 32, marginVertical: 48, backgroundColor: "#241B36", borderWidth: 1, borderColor: "#49375F", borderRadius: 24, gap: 10 }, footer: { width: "100%", maxWidth: 1240, alignSelf: "center", borderTopWidth: 1, borderColor: "#342B43", paddingTop: 25, gap: 10 },
});
