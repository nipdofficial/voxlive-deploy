import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

type SectionKey = "home" | "features" | "how" | "useCases" | "about";

const navItems: ReadonlyArray<[string, SectionKey]> = [
  ["Home", "home"],
  ["Features", "features"],
  ["How It Works", "how"],
  ["Use Cases", "useCases"],
  ["About", "about"],
];

const productPreviews = [
  {
    label: "Live workspace",
    description: "Organizer controls, audio status, source speech and Tamil translation in one focused workspace.",
    source: require("../assets/landing/live-workspace.png"),
    alt: "VoxLive organizer workspace showing live transcription and Tamil translation",
  },
  {
    label: "Session manager",
    description: "Create, schedule, start and revisit organizer sessions from a single protected view.",
    source: require("../assets/landing/session-manager.png"),
    alt: "VoxLive session management interface",
  },
  {
    label: "Tamil transcript",
    description: "Every saved result keeps the original words together with the available Tamil translation.",
    source: require("../assets/landing/tamil-transcript.png"),
    alt: "VoxLive transcript showing detected speech and Tamil output",
  },
];

const featureItems = [
  { icon: "radio", title: "Live Tamil Translation", text: "Speak in a supported language and see the original transcript alongside Tamil translation during your session.", featured: true },
  { icon: "mic", title: "Smart Recording", text: "Capture conversations, generate original-language transcripts, and translate them into Tamil whenever you need." },
  { icon: "upload-cloud", title: "Audio Upload", text: "Upload an existing audio recording and turn it into a readable transcript after processing." },
  { icon: "globe", title: "Mixed-Language Recognition", text: "Handle conversations that switch between supported languages, including Sinhala and English." },
  { icon: "users", title: "Session Sharing", text: "Invite attendees through secure session links and QR codes without exposing organizer controls." },
  { icon: "clock", title: "Transcript History", text: "Return to your saved sessions and transcripts through secure, authorized history." },
];

const translationExamples = [
  { language: "English", original: "Good morning everyone.", tamil: "அனைவருக்கும் காலை வணக்கம்." },
  { language: "Sinhala", original: "අපි අද රැස්වීම ආරම්භ කරමු.", tamil: "இன்றைய கூட்டத்தை ஆரம்பிப்போம்." },
  { language: "English", original: "Let us review the next action item.", tamil: "அடுத்த செயல் உருப்படியை மதிப்பாய்வு செய்வோம்." },
];

const useCases = [
  { title: "Meetings", text: "Keep multilingual teams aligned with a readable conversation record.", image: require("../assets/landing/meeting.webp") },
  { title: "Conferences", text: "Help audiences follow important sessions through live text and Tamil translation.", image: require("../assets/landing/conference.jpg") },
  { title: "Presentations", text: "Turn spoken explanations into structured text that is easier to revisit.", image: require("../assets/landing/conference.jpg") },
  { title: "Education", text: "Support lectures and discussions with original-language transcripts.", image: require("../assets/landing/education.webp") },
  { title: "Multilingual discussions", text: "Follow conversations that naturally move between supported languages.", image: require("../assets/landing/meeting.webp") },
];

const benefits = [
  ["zap", "Real-time communication support"],
  ["message-square", "Original-language transcription"],
  ["globe", "Tamil translation"],
  ["share-2", "Easy session sharing"],
  ["layout", "Clear and simple experience"],
  ["shield", "Authorized transcript history"],
] as const;

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={shared.brand}>
      <LinearGradient colors={["#B69CFF", "#7055E8"]} style={[shared.logo, compact && shared.logoCompact]}>
        <MaterialCommunityIcons name="waveform" size={compact ? 19 : 23} color="white" />
      </LinearGradient>
      <View>
        <Text style={[shared.brandName, compact && shared.brandNameCompact]}>VoxLive</Text>
        {!compact && <Text style={shared.brandTagline}>TURN EVERY VOICE INTO WORDS—LIVE</Text>}
      </View>
    </View>
  );
}

function ActionButton({ label, onPress, kind = "primary", icon }: { label: string; onPress: () => void; kind?: "primary" | "secondary" | "text"; icon?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed, hovered, focused }: any) => [
        shared.actionButton,
        kind === "primary" ? shared.actionPrimary : kind === "secondary" ? shared.actionSecondary : shared.actionText,
        hovered && shared.actionHover,
        focused && shared.focusRing,
        pressed && shared.actionPressed,
      ]}
    >
      <Text style={kind === "primary" ? shared.actionPrimaryText : shared.actionSecondaryText}>{label}</Text>
      {icon ? <Feather name={icon as any} size={16} color={kind === "primary" ? "#FFFFFF" : "#CFC2F7"} /> : null}
    </Pressable>
  );
}

function SectionHeading({ eyebrow, title, description, centered = false }: { eyebrow: string; title: string; description?: string; centered?: boolean }) {
  return (
    <View style={[shared.sectionHeading, centered && shared.centered]}>
      <Text style={shared.eyebrow}>{eyebrow}</Text>
      <Text accessibilityRole="header" style={[shared.sectionTitle, centered && shared.centerText]}>{title}</Text>
      {description ? <Text style={[shared.sectionDescription, centered && shared.centerText]}>{description}</Text> : null}
    </View>
  );
}

function Reveal({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: any }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translate = useRef(new Animated.Value(20)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => mounted && setReduceMotion(value));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      translate.setValue(0);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 620, delay, useNativeDriver: true }),
      Animated.timing(translate, { toValue: 0, duration: 620, delay, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [delay, opacity, reduceMotion, translate]);

  return <Animated.View style={[style, { opacity, transform: [{ translateY: translate }] }]}>{children}</Animated.View>;
}

function Waveform({ small = false }: { small?: boolean }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 1150, useNativeDriver: false }),
      Animated.timing(progress, { toValue: 0, duration: 1150, useNativeDriver: false }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);

  return (
    <View accessibilityRole="image" accessibilityLabel="Animated audio waveform" style={[shared.waveform, small && shared.waveformSmall]}>
      {Array.from({ length: small ? 14 : 24 }, (_, index) => {
        const low = small ? 5 : 8;
        const high = (small ? 16 : 34) - (index % 4) * 2;
        const height = reduceMotion ? low + ((index * 7) % Math.max(1, high - low)) : progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [low, high, low] });
        return <Animated.View key={index} style={[shared.waveBar, { height }]} />;
      })}
    </View>
  );
}

function HeroProductFrame({ compact }: { compact: boolean }) {
  return (
    <View style={[shared.productGlow, compact && shared.productGlowCompact]}>
      <View style={shared.productFrame}>
        <View style={shared.productTopbar}>
          <View style={shared.windowDots}><View style={[shared.windowDot, { backgroundColor: "#F36D82" }]} /><View style={[shared.windowDot, { backgroundColor: "#F3C969" }]} /><View style={[shared.windowDot, { backgroundColor: "#55D6A4" }]} /></View>
          <View style={shared.liveBadge}><View style={shared.liveDot} /><Text style={shared.liveBadgeText}>INTERFACE PREVIEW</Text></View>
          <Feather name="more-horizontal" size={18} color="#766F83" />
        </View>
        <View style={shared.productBody}>
          <View style={shared.productMeta}>
            <Text style={shared.productEyebrow}>ACTIVE SESSION</Text>
            <Text style={shared.productTitle}>Weekly product sync</Text>
            <Text style={shared.productCaption}>Mixed input · Tamil output</Text>
          </View>
          <View style={shared.wavePanel}><Waveform /><Text style={shared.listeningText}>Listening now</Text></View>
          <View style={shared.transcriptLine}>
            <View style={shared.timeRail}><Text style={shared.timeText}>00:18</Text><View style={shared.rail} /></View>
            <View style={shared.transcriptBody}>
              <View style={shared.speakerRow}><Text style={shared.speaker}>SPEAKER</Text><Text style={shared.languageBadge}>ENGLISH</Text></View>
              <Text style={shared.originalText}>Good morning everyone. Let&apos;s begin the meeting.</Text>
              <View style={shared.translationDivider} />
              <Text style={shared.translationLabel}>TAMIL TRANSLATION</Text>
              <Text style={shared.tamilText}>அனைவருக்கும் காலை வணக்கம். கூட்டத்தைத் தொடங்குவோம்.</Text>
            </View>
          </View>
        </View>
      </View>
      <View style={shared.floatingStatus}><View style={shared.statusIcon}><Feather name="check" size={15} color="#8AF0C6" /></View><View><Text style={shared.statusTitle}>Translation ready</Text><Text style={shared.statusCopy}>Original and Tamil stay connected</Text></View></View>
    </View>
  );
}

function FeatureCard({ item, compact }: { item: typeof featureItems[number]; compact: boolean }) {
  return (
    <View style={[shared.featureCard, item.featured && shared.featureCardFeatured, compact && shared.fullWidthCard]}>
      {item.featured ? <View style={shared.featuredAura} /> : null}
      <View style={shared.featureIcon}><Feather name={item.icon as any} size={21} color="#CBBEFF" /></View>
      <Text style={shared.featureTitle}>{item.title}</Text>
      <Text style={shared.featureText}>{item.text}</Text>
      {item.featured ? <View style={shared.featureWave}><Waveform small /></View> : null}
    </View>
  );
}

export default function LandingScreen({ onSignIn, onRegister }: { onSignIn: () => void; onRegister: () => void }) {
  const scroll = useRef<ScrollView>(null);
  const positions = useRef<Record<SectionKey, number>>({ home: 0, features: 0, how: 0, useCases: 0, about: 0 });
  const { width } = useWindowDimensions();
  const compact = width < 900;
  const narrow = width < 520;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>("home");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [exampleIndex, setExampleIndex] = useState(0);
  const styles = useMemo(() => createResponsiveStyles(compact, narrow), [compact, narrow]);

  const go = (section: SectionKey) => {
    setMobileMenuOpen(false);
    setActiveSection(section);
    scroll.current?.scrollTo({ y: Math.max(0, (positions.current[section] ?? 0) - 76), animated: true });
  };

  const remember = (section: SectionKey) => (event: any) => {
    positions.current[section] = event.nativeEvent.layout.y;
  };

  const trackSection = (event: any) => {
    const y = event.nativeEvent.contentOffset.y + 150;
    const ordered: SectionKey[] = ["home", "features", "how", "useCases", "about"];
    let current: SectionKey = "home";
    for (const key of ordered) if (y >= positions.current[key]) current = key;
    setActiveSection(current);
  };

  const example = translationExamples[exampleIndex] ?? translationExamples[0]!;
  const preview = productPreviews[previewIndex] ?? productPreviews[0]!;

  return (
    <ScrollView role="main" ref={scroll} style={styles.page} contentContainerStyle={styles.pageContent} onScroll={trackSection} scrollEventThrottle={80} keyboardShouldPersistTaps="handled">
      <View pointerEvents="none" style={shared.ambientLayer}><View style={shared.auroraOne} /><View style={shared.auroraTwo} /><View style={shared.gridOverlay} /></View>

      <View style={styles.navShell}>
        <View style={styles.navbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="VoxLive home" onPress={() => go("home")}><Brand compact={narrow} /></Pressable>
          {!compact ? (
            <View accessibilityLabel="Primary navigation" style={shared.desktopNav}>
              {navItems.map(([label, section]) => <Pressable key={section} accessibilityRole="button" onPress={() => go(section)} style={({ hovered, focused }: any) => [shared.navLink, activeSection === section && shared.navLinkActive, hovered && shared.navLinkHover, focused && shared.focusRing]}><Text style={[shared.navText, activeSection === section && shared.navTextActive]}>{label}</Text></Pressable>)}
            </View>
          ) : null}
          <View style={shared.navActions}>
            {!narrow ? <ActionButton label="Log in" onPress={onSignIn} kind="text" /> : null}
            <ActionButton label="Get Started" onPress={onRegister} kind="primary" />
            {compact ? <Pressable accessibilityRole="button" accessibilityLabel={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"} onPress={() => setMobileMenuOpen((value) => !value)} style={({ focused }: any) => [shared.menuButton, focused && shared.focusRing]}><Feather name={mobileMenuOpen ? "x" : "menu"} size={21} color="#EAE4F7" /></Pressable> : null}
          </View>
        </View>
        {compact && mobileMenuOpen ? <View accessibilityLabel="Mobile navigation" style={styles.mobileMenu}>{navItems.map(([label, section]) => <Pressable key={section} accessibilityRole="button" onPress={() => go(section)} style={[shared.mobileMenuItem, activeSection === section && shared.mobileMenuItemActive]}><Text style={[shared.navText, activeSection === section && shared.navTextActive]}>{label}</Text></Pressable>)}{narrow ? <Pressable accessibilityRole="button" onPress={onSignIn} style={shared.mobileMenuItem}><Text style={shared.navText}>Log in</Text></Pressable> : null}</View> : null}
      </View>

      <View onLayout={remember("home")} style={styles.hero}>
        <View style={styles.heroCopy}>
          <View style={shared.heroPill}><View style={shared.heroPillDot} /><Text style={shared.heroPillText}>AI-POWERED MULTILINGUAL SPEECH</Text></View>
          <Text accessibilityRole="header" style={styles.heroTitle}>Every Voice. Every Language. <Text style={shared.gradientWord}>One Understanding.</Text></Text>
          <Text style={styles.heroDescription}>Experience intelligent speech transcription and real-time Tamil translation with VoxLive. Capture conversations, break language barriers, and connect people through the power of AI.</Text>
          <View style={styles.heroActions}><ActionButton label="Get Started" onPress={onRegister} kind="primary" icon="arrow-up-right" /><ActionButton label="Explore Features" onPress={() => go("features")} kind="secondary" icon="arrow-down" /></View>
          <View style={styles.trustRow}>{["Original speech preserved", "Tamil translation", "Secure session history"].map((item) => <View key={item} style={shared.trustItem}><Feather name="check-circle" size={15} color="#8EE9C2" /><Text style={shared.trustText}>{item}</Text></View>)}</View>
        </View>
        <Reveal delay={150} style={styles.heroVisual}><HeroProductFrame compact={compact} /></Reveal>
      </View>

      <Reveal style={styles.logoStrip}>
        <Text style={shared.logoStripLabel}>BUILT FOR CONVERSATIONS THAT NEED TO BE UNDERSTOOD</Text>
        <View style={styles.logoStripItems}>{["Meetings", "Presentations", "Education", "Conferences", "Multilingual teams"].map((item) => <View key={item} style={shared.logoStripItem}><View style={shared.logoStripDot} /><Text style={shared.logoStripText}>{item}</Text></View>)}</View>
      </Reveal>

      <Reveal style={styles.section}>
        <SectionHeading eyebrow="REAL PRODUCT EXPERIENCE" title="See VoxLive in Action" description="Explore genuine screens from the working VoxLive application—designed for organizers, speakers and attendees." centered />
        <View role="tablist" style={styles.previewTabs}>{productPreviews.map((item, index) => <Pressable key={item.label} accessibilityRole="tab" accessibilityState={{ selected: index === previewIndex }} onPress={() => setPreviewIndex(index)} style={({ hovered, focused }: any) => [shared.previewTab, index === previewIndex && shared.previewTabActive, hovered && shared.previewTabHover, focused && shared.focusRing]}><Text style={[shared.previewTabText, index === previewIndex && shared.previewTabTextActive]}>{item.label}</Text></Pressable>)}</View>
        <View style={styles.previewFrame}>
          <View style={shared.previewFrameTop}><View style={shared.windowDots}><View style={[shared.windowDot, { backgroundColor: "#F36D82" }]} /><View style={[shared.windowDot, { backgroundColor: "#F3C969" }]} /><View style={[shared.windowDot, { backgroundColor: "#55D6A4" }]} /></View><Text style={shared.previewFrameTitle}>{preview.label}</Text><View style={shared.secureBadge}><Feather name="shield" size={12} color="#9CE7C8" /><Text style={shared.secureBadgeText}>ACTUAL APP VIEW</Text></View></View>
          <Image key={preview.label} source={preview.source} accessibilityLabel={preview.alt} resizeMode="cover" style={styles.previewImage} />
          <View style={shared.previewCaption}><Text style={shared.previewCaptionTitle}>{preview.label}</Text><Text style={shared.previewCaptionText}>{preview.description}</Text></View>
        </View>
      </Reveal>

      <View onLayout={remember("features")} style={styles.section}>
        <Reveal><SectionHeading eyebrow="POWERFUL, PURPOSEFUL FEATURES" title="Everything you need to turn speech into shared understanding" description="A focused toolkit for capturing, translating, sharing and revisiting important conversations." /></Reveal>
        <View style={styles.featureGrid}>{featureItems.map((item) => <FeatureCard key={item.title} item={item} compact={narrow} />)}</View>
      </View>

      <View onLayout={remember("how")} style={styles.section}>
        <Reveal><SectionHeading eyebrow="A SIMPLE WORKFLOW" title="From Speech to Understanding in Three Simple Steps" description="Start quickly, keep the conversation natural, and let VoxLive organize the result." centered /></Reveal>
        <View style={styles.stepsGrid}>{[["01", "plus-circle", "Create a Session", "Sign in and select Record, Live, or Upload."], ["02", "mic", "Capture or Process Audio", "Speak through your microphone or upload a recording."], ["03", "file-text", "Get Your Results", "View original transcripts, Tamil translations where enabled, and saved history."]].map(([number, icon, title, text], index) => <View key={number} style={[shared.stepCard, narrow && shared.fullWidthCard]}><View style={shared.stepHeader}><Text style={shared.stepNumber}>{number}</Text><View style={shared.stepIcon}><Feather name={icon as any} size={21} color="#CBBEFF" /></View></View><Text style={shared.stepTitle}>{title}</Text><Text style={shared.stepText}>{text}</Text>{index < 2 && !compact ? <View style={shared.stepConnector}><View style={shared.stepConnectorLine} /><Feather name="chevron-right" size={16} color="#7359D8" /></View> : null}</View>)}</View>
      </View>

      <View onLayout={remember("useCases")} style={styles.section}>
        <Reveal><SectionHeading eyebrow="DESIGNED FOR REAL CONVERSATIONS" title="One platform, many ways to connect" description="From focused team sessions to multilingual learning, VoxLive keeps spoken information readable and useful." /></Reveal>
        <View style={styles.useCaseGrid}>{useCases.map((item, index) => <ImageBackground key={item.title} source={item.image} resizeMode="cover" accessibilityLabel={`${item.title} use case`} imageStyle={shared.useCaseImage} style={[shared.useCaseCard, index === 0 && !compact && shared.useCaseFeatured, narrow && shared.fullWidthCard]}><LinearGradient colors={["rgba(12,9,18,0.08)", "rgba(12,9,18,0.94)"]} style={shared.useCaseOverlay}><View style={shared.useCaseTag}><Feather name="arrow-up-right" size={13} color="#D9CFFF" /></View><View><Text style={shared.useCaseTitle}>{item.title}</Text><Text style={shared.useCaseText}>{item.text}</Text></View></LinearGradient></ImageBackground>)}</View>
        <Text style={shared.photoCredit}>Use-case photography: Vitaly Gariev / Unsplash and Matheus Bertelli / Pexels.</Text>
      </View>

      <Reveal style={styles.demoSection}>
        <View style={styles.demoCopy}><Text style={shared.eyebrow}>VISUAL DEMONSTRATION</Text><Text accessibilityRole="header" style={shared.demoTitle}>See how one spoken idea becomes easier to follow.</Text><Text style={shared.demoDescription}>Choose an example to see the original words paired with Tamil. This is an illustrative product demonstration—not a live Gemini request.</Text><View style={styles.exampleButtons}>{translationExamples.map((item, index) => <Pressable key={`${item.language}-${index}`} accessibilityRole="button" accessibilityState={{ selected: index === exampleIndex }} onPress={() => setExampleIndex(index)} style={({ hovered, focused }: any) => [shared.exampleButton, index === exampleIndex && shared.exampleButtonActive, hovered && shared.previewTabHover, focused && shared.focusRing]}><Text style={[shared.exampleButtonText, index === exampleIndex && shared.exampleButtonTextActive]}>{item.language} {index + 1}</Text></Pressable>)}</View></View>
        <View style={styles.demoPanels}><View style={shared.demoPanel}><View style={shared.demoPanelHeader}><View style={shared.demoIcon}><Feather name="mic" size={16} color="#CBBEFF" /></View><View><Text style={shared.demoPanelLabel}>ORIGINAL SPEECH</Text><Text style={shared.demoLanguage}>{example.language}</Text></View></View><Text style={shared.demoOriginal}>{example.original}</Text><Waveform small /></View><View style={shared.demoArrow}><Feather name={compact ? "arrow-down" : "arrow-right"} size={20} color="#CBBEFF" /></View><LinearGradient colors={["rgba(116,88,222,0.32)", "rgba(63,45,104,0.22)"]} style={shared.demoPanel}><View style={shared.demoPanelHeader}><View style={shared.demoIcon}><MaterialCommunityIcons name="translate" size={17} color="#CBBEFF" /></View><View><Text style={shared.demoPanelLabel}>TAMIL TRANSLATION</Text><Text style={shared.demoLanguage}>Tamil</Text></View></View><Text style={shared.demoTamil}>{example.tamil}</Text><View style={shared.translationReady}><Feather name="check-circle" size={14} color="#8EE9C2" /><Text style={shared.translationReadyText}>Translation paired with source</Text></View></LinearGradient></View>
      </Reveal>

      <View style={styles.section}>
        <Reveal><SectionHeading eyebrow="WHY VOXLIVE" title="Less friction. More understanding." description="Practical benefits for organizers and attendees—without unnecessary complexity." centered /></Reveal>
        <View style={styles.benefitGrid}>{benefits.map(([icon, label]) => <View key={label} style={[shared.benefitCard, narrow && shared.fullWidthCard]}><View style={shared.benefitIcon}><Feather name={icon as any} size={19} color="#CDBFFF" /></View><Text style={shared.benefitText}>{label}</Text></View>)}</View>
      </View>

      <View onLayout={remember("about")} style={styles.section}>
        <Reveal style={styles.aboutPanel}><View style={styles.aboutCopy}><Text style={shared.eyebrow}>ABOUT VOXLIVE</Text><Text accessibilityRole="header" style={shared.aboutTitle}>Technology should make every conversation easier to understand.</Text><Text style={shared.aboutText}>VoxLive brings original speech, Tamil translation and secure session tools into one calm, readable experience. It is designed for meetings, presentations, education and multilingual discussions.</Text></View><View style={styles.aboutStats}>{[["3", "Flexible workflows"], ["Live", "Tamil translation"], ["Secure", "Organizer history"]].map(([value, label]) => <View key={label} style={shared.aboutStat}><Text style={shared.aboutStatValue}>{value}</Text><Text style={shared.aboutStatLabel}>{label}</Text></View>)}</View></Reveal>
      </View>

      <Reveal style={styles.cta}><View style={shared.ctaGlow} /><View style={styles.ctaCopy}><Text style={shared.ctaEyebrow}>YOUR NEXT CONVERSATION STARTS HERE</Text><Text accessibilityRole="header" style={styles.ctaTitle}>Ready to Make Every Conversation Count?</Text><Text style={styles.ctaText}>Start using VoxLive to capture speech, generate transcripts, and connect through real-time Tamil translation.</Text></View><ActionButton label="Get Started with VoxLive" onPress={onRegister} kind="primary" icon="arrow-up-right" /></Reveal>

      <View style={styles.footer}>
        <View style={styles.footerBrand}><Brand /><Text style={shared.footerDescription}>Intelligent speech transcription and real-time Tamil translation for conversations that matter.</Text></View>
        <View style={styles.footerLinks}><View style={shared.footerColumn}><Text style={shared.footerTitle}>Product</Text>{[["Features", "features"], ["How It Works", "how"], ["Use Cases", "useCases"]].map(([label, section]) => <Pressable key={label} onPress={() => go(section as SectionKey)}><Text style={shared.footerLink}>{label}</Text></Pressable>)}</View><View style={shared.footerColumn}><Text style={shared.footerTitle}>VoxLive</Text><Pressable onPress={() => go("about")}><Text style={shared.footerLink}>About</Text></Pressable><Pressable onPress={onSignIn}><Text style={shared.footerLink}>Organizer Login</Text></Pressable><Pressable onPress={onRegister}><Text style={shared.footerLink}>Get Started</Text></Pressable></View><View style={shared.footerColumn}><Text style={shared.footerTitle}>Privacy</Text><Text style={shared.footerMuted}>Transcript history is available only to authorized users.</Text><Text style={shared.footerMuted}>Audio is processed to provide requested transcription features.</Text></View></View>
        <View style={styles.footerBottom}><Text style={shared.footerMuted}>© {new Date().getFullYear()} VoxLive. All rights reserved.</Text><Text style={shared.footerMuted}>Built for clear, connected conversations.</Text></View>
      </View>
    </ScrollView>
  );
}

function createResponsiveStyles(compact: boolean, narrow: boolean) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: "#0C0912" },
    pageContent: { paddingBottom: 0, overflow: "hidden" },
    navShell: { width: "100%", maxWidth: 1320, alignSelf: "center", paddingHorizontal: narrow ? 16 : 28, paddingTop: 14, zIndex: 20 },
    navbar: { minHeight: 68, paddingHorizontal: narrow ? 14 : 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 18, backgroundColor: "rgba(21,17,30,0.94)", borderWidth: 1, borderColor: "rgba(202,188,255,0.13)", borderRadius: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.28, shadowRadius: 28 },
    mobileMenu: { marginTop: 8, padding: 10, borderRadius: 18, borderWidth: 1, borderColor: "rgba(202,188,255,0.13)", backgroundColor: "#171220", gap: 4 },
    hero: { width: "100%", maxWidth: 1320, alignSelf: "center", minHeight: compact ? undefined : 760, paddingHorizontal: narrow ? 18 : 30, paddingTop: compact ? 72 : 118, paddingBottom: compact ? 76 : 104, flexDirection: compact ? "column" : "row", alignItems: "center", gap: compact ? 64 : 54 },
    heroCopy: { flex: compact ? undefined : 0.92, width: compact ? "100%" : undefined, maxWidth: compact ? 760 : 620 },
    heroVisual: { flex: compact ? undefined : 1.08, width: "100%", maxWidth: compact ? 780 : 700 },
    heroTitle: { color: "#F8F5FF", fontFamily: "DMSans_700Bold", fontSize: narrow ? 43 : compact ? 58 : 68, lineHeight: narrow ? 49 : compact ? 65 : 74, letterSpacing: narrow ? -1.7 : -3.1, marginTop: 22 },
    heroDescription: { color: "#B9B1C6", fontFamily: "DMSans_400Regular", fontSize: narrow ? 16 : 18, lineHeight: narrow ? 25 : 29, maxWidth: 590, marginTop: 24 },
    heroActions: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 32 },
    trustRow: { flexDirection: "row", flexWrap: "wrap", gap: narrow ? 12 : 20, marginTop: 28 },
    logoStrip: { width: "100%", maxWidth: 1260, alignSelf: "center", marginHorizontal: narrow ? 18 : 30, paddingHorizontal: narrow ? 20 : 30, paddingVertical: 24, borderTopWidth: 1, borderBottomWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
    logoStripItems: { marginTop: 17, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: narrow ? 15 : 28 },
    section: { width: "100%", maxWidth: 1260, alignSelf: "center", paddingHorizontal: narrow ? 18 : 30, paddingVertical: compact ? 82 : 116 },
    previewTabs: { marginTop: 34, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
    previewFrame: { marginTop: 24, borderRadius: narrow ? 20 : 28, overflow: "hidden", backgroundColor: "#14101C", borderWidth: 1, borderColor: "rgba(202,188,255,0.16)", shadowColor: "#6D4DE8", shadowOpacity: 0.18, shadowRadius: 42, shadowOffset: { width: 0, height: 18 } },
    previewImage: { width: "100%", height: narrow ? 240 : compact ? 410 : 590, backgroundColor: "#0D0A12" },
    featureGrid: { marginTop: 42, flexDirection: "row", flexWrap: "wrap", gap: 16 },
    stepsGrid: { marginTop: 48, flexDirection: compact ? "column" : "row", gap: 16 },
    useCaseGrid: { marginTop: 42, flexDirection: "row", flexWrap: "wrap", gap: 16 },
    demoSection: { width: "100%", maxWidth: 1260, alignSelf: "center", marginVertical: compact ? 70 : 96, paddingHorizontal: narrow ? 18 : 30, paddingVertical: compact ? 46 : 64, flexDirection: compact ? "column" : "row", alignItems: "center", gap: 46, borderRadius: narrow ? 0 : 32, borderWidth: narrow ? 0 : 1, borderColor: "rgba(202,188,255,0.15)", backgroundColor: "rgba(25,18,37,0.76)" },
    demoCopy: { flex: 0.8, width: compact ? "100%" : undefined },
    demoPanels: { flex: 1.2, width: "100%", flexDirection: compact ? "column" : "row", alignItems: "center", gap: 12 },
    exampleButtons: { marginTop: 24, flexDirection: "row", flexWrap: "wrap", gap: 8 },
    benefitGrid: { marginTop: 40, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12 },
    aboutPanel: { padding: narrow ? 24 : 42, flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 32, borderRadius: 28, borderWidth: 1, borderColor: "rgba(202,188,255,0.15)", backgroundColor: "rgba(28,21,42,0.85)", overflow: "hidden" },
    aboutCopy: { flex: 1, maxWidth: 700 },
    aboutStats: { flexDirection: narrow ? "column" : "row", gap: 10, width: compact ? "100%" : undefined },
    cta: { width: "100%", maxWidth: 1260, alignSelf: "center", marginHorizontal: narrow ? 18 : 30, marginBottom: 104, padding: narrow ? 28 : 52, borderRadius: 32, overflow: "hidden", flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 30, borderWidth: 1, borderColor: "rgba(209,196,255,0.24)", backgroundColor: "#241742" },
    ctaCopy: { flex: 1, maxWidth: 760 },
    ctaTitle: { color: "#FFFFFF", fontFamily: "DMSans_700Bold", fontSize: narrow ? 32 : 44, lineHeight: narrow ? 39 : 51, letterSpacing: -1.4, marginTop: 12 },
    ctaText: { color: "#C8BDE0", fontFamily: "DMSans_400Regular", fontSize: 16, lineHeight: 25, marginTop: 13, maxWidth: 680 },
    footer: { paddingHorizontal: narrow ? 20 : 34, paddingTop: 58, paddingBottom: 28, backgroundColor: "#08060C", borderTopWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
    footerBrand: { width: "100%", maxWidth: 1260, alignSelf: "center" },
    footerLinks: { width: "100%", maxWidth: 1260, alignSelf: "center", marginTop: 42, paddingVertical: 38, flexDirection: "row", flexWrap: "wrap", gap: narrow ? 34 : 72, borderTopWidth: 1, borderBottomWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
    footerBottom: { width: "100%", maxWidth: 1260, alignSelf: "center", paddingTop: 24, flexDirection: narrow ? "column" : "row", justifyContent: "space-between", gap: 8 },
  });
}

const shared = StyleSheet.create({
  ambientLayer: { position: "absolute", top: 0, left: 0, right: 0, height: 1100, overflow: "hidden" },
  auroraOne: { position: "absolute", width: 600, height: 600, borderRadius: 300, top: -250, right: -80, backgroundColor: "rgba(111,76,232,0.16)" },
  auroraTwo: { position: "absolute", width: 520, height: 520, borderRadius: 260, top: 260, left: -310, backgroundColor: "rgba(143,95,255,0.1)" },
  gridOverlay: { position: "absolute", top: 0, left: 0, right: 0, height: 760, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.025)" },
  brand: { flexDirection: "row", alignItems: "center", gap: 11 },
  logo: { width: 43, height: 43, borderRadius: 14, alignItems: "center", justifyContent: "center", shadowColor: "#8F72F8", shadowOpacity: 0.35, shadowRadius: 14 },
  logoCompact: { width: 36, height: 36, borderRadius: 11 },
  brandName: { color: "#F6F2FF", fontFamily: "DMSans_700Bold", fontSize: 20, letterSpacing: -0.4 },
  brandNameCompact: { fontSize: 17 },
  brandTagline: { color: "#8E839C", fontFamily: "DMSans_600SemiBold", fontSize: 6.8, letterSpacing: 1.1, marginTop: 2 },
  desktopNav: { flexDirection: "row", alignItems: "center", gap: 2 },
  navLink: { minHeight: 40, paddingHorizontal: 13, borderRadius: 11, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  navLinkActive: { backgroundColor: "rgba(137,105,238,0.1)", borderBottomColor: "#8C6BE8" },
  navLinkHover: { backgroundColor: "rgba(255,255,255,0.045)" },
  navText: { color: "#B8AFC5", fontFamily: "DMSans_600SemiBold", fontSize: 12.5 },
  navTextActive: { color: "#EEE8FF" },
  navActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  menuButton: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: "rgba(202,188,255,0.15)", backgroundColor: "rgba(255,255,255,0.04)", alignItems: "center", justifyContent: "center" },
  mobileMenuItem: { minHeight: 42, paddingHorizontal: 14, borderRadius: 11, justifyContent: "center" },
  mobileMenuItemActive: { backgroundColor: "rgba(137,105,238,0.12)" },
  actionButton: { minHeight: 44, paddingHorizontal: 18, borderRadius: 13, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1 },
  actionPrimary: { backgroundColor: "#7658E4", borderColor: "#8D70ED", shadowColor: "#7658E4", shadowOpacity: 0.26, shadowRadius: 16, shadowOffset: { width: 0, height: 7 } },
  actionSecondary: { backgroundColor: "rgba(255,255,255,0.025)", borderColor: "rgba(202,188,255,0.22)" },
  actionText: { backgroundColor: "transparent", borderColor: "transparent", paddingHorizontal: 10 },
  actionPrimaryText: { color: "#FFFFFF", fontFamily: "DMSans_700Bold", fontSize: 13.5 },
  actionSecondaryText: { color: "#DCD3EE", fontFamily: "DMSans_600SemiBold", fontSize: 13.5 },
  actionHover: { transform: [{ translateY: -2 }], borderColor: "#9C82F2" },
  actionPressed: { opacity: 0.84, transform: [{ translateY: 0 }] },
  focusRing: { borderColor: "#CBBEFF", borderWidth: 2 },
  heroPill: { alignSelf: "flex-start", minHeight: 30, paddingHorizontal: 12, borderRadius: 15, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(116,88,222,0.11)", borderWidth: 1, borderColor: "rgba(176,149,255,0.2)" },
  heroPillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#9B7CF5", shadowColor: "#9B7CF5", shadowOpacity: 0.8, shadowRadius: 7 },
  heroPillText: { color: "#C7B8F2", fontFamily: "DMSans_700Bold", fontSize: 9, letterSpacing: 1.45 },
  gradientWord: { color: "#BCA7FF" },
  trustItem: { flexDirection: "row", alignItems: "center", gap: 7 },
  trustText: { color: "#8F879B", fontFamily: "DMSans_500Medium", fontSize: 11.5 },
  productGlow: { padding: 10, borderRadius: 32, backgroundColor: "rgba(120,83,235,0.09)", shadowColor: "#7658E4", shadowOpacity: 0.32, shadowRadius: 48, shadowOffset: { width: 0, height: 20 } },
  productGlowCompact: { maxWidth: 720, alignSelf: "center" },
  productFrame: { borderRadius: 26, overflow: "hidden", borderWidth: 1, borderColor: "rgba(212,200,255,0.19)", backgroundColor: "#15111D" },
  productTopbar: { height: 52, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.07)" },
  windowDots: { flexDirection: "row", alignItems: "center", gap: 6 },
  windowDot: { width: 7, height: 7, borderRadius: 4 },
  liveBadge: { paddingHorizontal: 10, height: 26, borderRadius: 13, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(85,214,164,0.09)", borderWidth: 1, borderColor: "rgba(85,214,164,0.18)" },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#55D6A4" },
  liveBadgeText: { color: "#A7EED2", fontFamily: "DMSans_700Bold", fontSize: 7.5, letterSpacing: 1 },
  productBody: { padding: 22 },
  productMeta: { marginBottom: 18 },
  productEyebrow: { color: "#8F73E8", fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 1.4 },
  productTitle: { color: "#F1EDF8", fontFamily: "DMSans_700Bold", fontSize: 20, marginTop: 7 },
  productCaption: { color: "#837B8C", fontFamily: "DMSans_400Regular", fontSize: 11, marginTop: 4 },
  wavePanel: { minHeight: 92, paddingHorizontal: 16, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#1F1929", borderWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
  waveform: { height: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 },
  waveformSmall: { height: 24, justifyContent: "flex-start", gap: 2 },
  waveBar: { width: 3, minHeight: 4, borderRadius: 2, backgroundColor: "#8266D7" },
  listeningText: { color: "#807789", fontFamily: "DMSans_600SemiBold", fontSize: 8, letterSpacing: 1.2, marginTop: 6 },
  transcriptLine: { marginTop: 18, padding: 17, borderRadius: 17, flexDirection: "row", gap: 13, backgroundColor: "rgba(255,255,255,0.025)", borderWidth: 1, borderColor: "rgba(202,188,255,0.11)" },
  timeRail: { width: 38, alignItems: "center" },
  timeText: { color: "#7E7588", fontFamily: "DMSans_600SemiBold", fontSize: 9 },
  rail: { width: 2, flex: 1, minHeight: 76, marginTop: 8, borderRadius: 1, backgroundColor: "#7B5DDB" },
  transcriptBody: { flex: 1 },
  speakerRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  speaker: { color: "#CFC3EA", fontFamily: "DMSans_700Bold", fontSize: 8.5, letterSpacing: 0.8 },
  languageBadge: { color: "#8F879A", fontFamily: "DMSans_700Bold", fontSize: 7, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.05)" },
  originalText: { color: "#E6E0ED", fontFamily: "DMSans_500Medium", fontSize: 13, lineHeight: 20, marginTop: 8 },
  translationDivider: { height: 1, backgroundColor: "rgba(202,188,255,0.1)", marginVertical: 11 },
  translationLabel: { color: "#8E72E7", fontFamily: "DMSans_700Bold", fontSize: 7.5, letterSpacing: 1.1 },
  tamilText: { color: "#CFC3EA", fontFamily: "DMSans_500Medium", fontSize: 12.5, lineHeight: 21, marginTop: 6 },
  floatingStatus: { position: "absolute", right: -4, bottom: -28, maxWidth: 230, padding: 13, borderRadius: 15, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#211A2B", borderWidth: 1, borderColor: "rgba(140,224,191,0.24)", shadowColor: "#000", shadowOpacity: 0.34, shadowRadius: 18, shadowOffset: { width: 0, height: 9 } },
  statusIcon: { width: 29, height: 29, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(85,214,164,0.1)" },
  statusTitle: { color: "#DDF6EC", fontFamily: "DMSans_700Bold", fontSize: 10.5 },
  statusCopy: { color: "#857D8F", fontFamily: "DMSans_400Regular", fontSize: 8.5, marginTop: 2 },
  logoStripLabel: { color: "#766D81", fontFamily: "DMSans_700Bold", fontSize: 8.5, letterSpacing: 1.7, textAlign: "center" },
  logoStripItem: { flexDirection: "row", alignItems: "center", gap: 8 },
  logoStripDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#634BB2" },
  logoStripText: { color: "#9C93A8", fontFamily: "DMSans_600SemiBold", fontSize: 12 },
  sectionHeading: { maxWidth: 760 },
  centered: { alignSelf: "center", alignItems: "center", maxWidth: 820 },
  centerText: { textAlign: "center" },
  eyebrow: { color: "#9E82F0", fontFamily: "DMSans_700Bold", fontSize: 9.5, letterSpacing: 1.9 },
  sectionTitle: { color: "#F5F1FB", fontFamily: "DMSans_700Bold", fontSize: 39, lineHeight: 47, letterSpacing: -1.4, marginTop: 13 },
  sectionDescription: { color: "#9E96A9", fontFamily: "DMSans_400Regular", fontSize: 15, lineHeight: 24, marginTop: 13, maxWidth: 700 },
  previewTab: { minHeight: 40, paddingHorizontal: 15, borderRadius: 12, justifyContent: "center", borderWidth: 1, borderColor: "rgba(202,188,255,0.11)", backgroundColor: "rgba(255,255,255,0.025)" },
  previewTabActive: { borderColor: "#8063D1", backgroundColor: "rgba(116,88,222,0.18)" },
  previewTabHover: { borderColor: "rgba(202,188,255,0.3)" },
  previewTabText: { color: "#958C9F", fontFamily: "DMSans_600SemiBold", fontSize: 12 },
  previewTabTextActive: { color: "#E8E0FF" },
  previewFrameTop: { height: 48, paddingHorizontal: 17, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  previewFrameTitle: { color: "#AFA5BC", fontFamily: "DMSans_600SemiBold", fontSize: 10 },
  secureBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
  secureBadgeText: { color: "#8FCAB3", fontFamily: "DMSans_700Bold", fontSize: 7.5, letterSpacing: 0.9 },
  previewCaption: { padding: 20, borderTopWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  previewCaptionTitle: { color: "#F0EBF7", fontFamily: "DMSans_700Bold", fontSize: 15 },
  previewCaptionText: { color: "#8F8798", fontFamily: "DMSans_400Regular", fontSize: 12, lineHeight: 19, marginTop: 5 },
  featureCard: { flexGrow: 1, flexBasis: 300, minHeight: 230, padding: 26, borderRadius: 23, overflow: "hidden", backgroundColor: "rgba(24,19,34,0.92)", borderWidth: 1, borderColor: "rgba(202,188,255,0.11)" },
  featureCardFeatured: { flexBasis: 620, minHeight: 270, borderColor: "rgba(157,126,245,0.32)", backgroundColor: "rgba(35,25,53,0.94)" },
  fullWidthCard: { flexBasis: "100%", width: "100%" },
  featuredAura: { position: "absolute", width: 260, height: 260, borderRadius: 130, right: -80, top: -110, backgroundColor: "rgba(122,88,228,0.16)" },
  featureIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(116,88,222,0.13)", borderWidth: 1, borderColor: "rgba(202,188,255,0.11)" },
  featureTitle: { color: "#EEE9F6", fontFamily: "DMSans_700Bold", fontSize: 18, marginTop: 20 },
  featureText: { color: "#9C93A6", fontFamily: "DMSans_400Regular", fontSize: 13.5, lineHeight: 21, marginTop: 9, maxWidth: 520 },
  featureWave: { marginTop: 22 },
  stepCard: { flex: 1, minHeight: 238, padding: 27, borderRadius: 23, backgroundColor: "#16121E", borderWidth: 1, borderColor: "rgba(202,188,255,0.11)" },
  stepHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepNumber: { color: "#7658D9", fontFamily: "DMSans_700Bold", fontSize: 34, letterSpacing: -1.8 },
  stepIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(116,88,222,0.12)" },
  stepTitle: { color: "#EEE9F6", fontFamily: "DMSans_700Bold", fontSize: 18, marginTop: 34 },
  stepText: { color: "#978E9F", fontFamily: "DMSans_400Regular", fontSize: 13.5, lineHeight: 21, marginTop: 9 },
  stepConnector: { position: "absolute", right: -28, top: 108, width: 40, flexDirection: "row", alignItems: "center", zIndex: 4 },
  stepConnectorLine: { flex: 1, height: 1, backgroundColor: "#4D396F" },
  useCaseCard: { flexGrow: 1, flexBasis: 270, minHeight: 330, borderRadius: 23, overflow: "hidden", borderWidth: 1, borderColor: "rgba(202,188,255,0.13)", backgroundColor: "#17121F" },
  useCaseFeatured: { flexBasis: 560 },
  useCaseImage: { borderRadius: 23 },
  useCaseOverlay: { flex: 1, padding: 22, justifyContent: "space-between" },
  useCaseTag: { alignSelf: "flex-end", width: 34, height: 34, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(18,13,27,0.72)", borderWidth: 1, borderColor: "rgba(255,255,255,0.13)" },
  useCaseTitle: { color: "#FFFFFF", fontFamily: "DMSans_700Bold", fontSize: 21 },
  useCaseText: { color: "#C7BFCE", fontFamily: "DMSans_400Regular", fontSize: 12.5, lineHeight: 19, marginTop: 7, maxWidth: 420 },
  photoCredit: { color: "#625B6B", fontFamily: "DMSans_400Regular", fontSize: 9.5, marginTop: 13 },
  demoTitle: { color: "#F5F1FB", fontFamily: "DMSans_700Bold", fontSize: 34, lineHeight: 42, letterSpacing: -1.1, marginTop: 13 },
  demoDescription: { color: "#9E96A9", fontFamily: "DMSans_400Regular", fontSize: 14, lineHeight: 22, marginTop: 14 },
  exampleButton: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10, justifyContent: "center", borderWidth: 1, borderColor: "rgba(202,188,255,0.12)" },
  exampleButtonActive: { backgroundColor: "#7658D9", borderColor: "#9376EA" },
  exampleButtonText: { color: "#918899", fontFamily: "DMSans_600SemiBold", fontSize: 10.5 },
  exampleButtonTextActive: { color: "#FFFFFF" },
  demoPanel: { flex: 1, width: "100%", minHeight: 235, padding: 20, borderRadius: 21, justifyContent: "space-between", backgroundColor: "#141019", borderWidth: 1, borderColor: "rgba(202,188,255,0.13)" },
  demoPanelHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  demoIcon: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(116,88,222,0.13)" },
  demoPanelLabel: { color: "#8F73E8", fontFamily: "DMSans_700Bold", fontSize: 7.5, letterSpacing: 1.1 },
  demoLanguage: { color: "#8E8597", fontFamily: "DMSans_500Medium", fontSize: 9.5, marginTop: 2 },
  demoOriginal: { color: "#E9E3F0", fontFamily: "DMSans_600SemiBold", fontSize: 17, lineHeight: 26, marginVertical: 22 },
  demoTamil: { color: "#E0D5F6", fontFamily: "DMSans_600SemiBold", fontSize: 17, lineHeight: 29, marginVertical: 22 },
  demoArrow: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "#2B203C", borderWidth: 1, borderColor: "rgba(202,188,255,0.16)" },
  translationReady: { flexDirection: "row", alignItems: "center", gap: 7 },
  translationReadyText: { color: "#8CBBA8", fontFamily: "DMSans_600SemiBold", fontSize: 9 },
  benefitCard: { flexGrow: 1, flexBasis: 180, maxWidth: 290, minHeight: 132, padding: 18, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,18,31,0.9)", borderWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
  benefitIcon: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(116,88,222,0.12)" },
  benefitText: { color: "#CFC8D7", fontFamily: "DMSans_600SemiBold", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 12 },
  aboutTitle: { color: "#F5F1FB", fontFamily: "DMSans_700Bold", fontSize: 35, lineHeight: 43, letterSpacing: -1.2, marginTop: 13 },
  aboutText: { color: "#9C93A6", fontFamily: "DMSans_400Regular", fontSize: 14.5, lineHeight: 23, marginTop: 14 },
  aboutStat: { minWidth: 132, padding: 18, borderRadius: 17, backgroundColor: "rgba(255,255,255,0.03)", borderWidth: 1, borderColor: "rgba(202,188,255,0.1)" },
  aboutStatValue: { color: "#CBBEFF", fontFamily: "DMSans_700Bold", fontSize: 22 },
  aboutStatLabel: { color: "#8F8798", fontFamily: "DMSans_500Medium", fontSize: 10.5, marginTop: 5 },
  ctaGlow: { position: "absolute", width: 420, height: 420, borderRadius: 210, right: -100, top: -220, backgroundColor: "rgba(168,130,255,0.18)" },
  ctaEyebrow: { color: "#BFAEFF", fontFamily: "DMSans_700Bold", fontSize: 9, letterSpacing: 1.7 },
  footerDescription: { color: "#837A8B", fontFamily: "DMSans_400Regular", fontSize: 12.5, lineHeight: 20, maxWidth: 390, marginTop: 16 },
  footerColumn: { minWidth: 150, maxWidth: 280, gap: 12 },
  footerTitle: { color: "#DCD5E5", fontFamily: "DMSans_700Bold", fontSize: 11.5, marginBottom: 4 },
  footerLink: { color: "#8F8798", fontFamily: "DMSans_500Medium", fontSize: 11.5 },
  footerMuted: { color: "#665F6D", fontFamily: "DMSans_400Regular", fontSize: 10.5, lineHeight: 17 },
});
