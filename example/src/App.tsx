// The Necessary SDK against its sample backends (../backend), section by section: the
// installation, the scan with every measurement it sent, an account, requests with and without
// the person's approval, and requests a backend must refuse. setup.ts makes the DeviceTrust,
// sampleApi.ts signs what the app sends, ScanView.tsx reads a scan; this file is the screen.
//
// Start a sample backend, name it in src/backends.json -- {"Sample": "http://10.0.2.2:8787"} is
// the development machine as the Android emulator sees it -- and run the app. To choose among
// several, name each: {"Python": "https://…", "TypeScript": "https://…"}.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ApiException,
  NativeKeyException,
  PersonalMeasurement,
  personalMeasurements,
  SecureScreen,
  type DeviceTrust,
  type ScanResult,
} from '@necessarysdk/react-native';
import { personalInfo } from './measurements';
import { SampleApi } from './sampleApi';
import { ScanView } from './ScanView';
import { backends, setUpDeviceTrust } from './setup';
import { colors } from './theme';

/** What a backend that makes the guide's checks does with a request. */
type Expect = 'accepted' | 'refused';

/** One action's result as shown: [asExpected] when the backend did what [Expect] says. */
interface Outcome {
  action: string;
  text: string;
  asExpected: boolean;
}

const names = Object.keys(backends);

export default function App() {
  const [backend, setBackend] = useState(names[0]);
  const trustRef = useRef<DeviceTrust>(setUpDeviceTrust(backends[names[0]]));
  const apiRef = useRef(new SampleApi(trustRef.current));
  const trust = trustRef.current;
  const api = apiRef.current;
  const [, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [locationPermission, setLocationPermission] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<Record<string, Outcome>>({});
  const [log, setLog] = useState<Outcome[]>([]);
  const [handle, setHandle] = useState('example');
  const [password, setPassword] = useState('example password');
  const [pin, setPin] = useState('');
  const [shared, setShared] = useState('');
  const protectedSecrets = useRef(0);

  useEffect(() => () => trustRef.current.close(), []);

  /** No screenshots or recordings of the window while a secret is typed. */
  const typingSecret = (typing: boolean) => {
    if (typing) {
      protectedSecrets.current += 1;
      void SecureScreen.protect(true);
    } else if (protectedSecrets.current > 0) {
      protectedSecrets.current -= 1;
      void SecureScreen.protect(false);
    }
  };

  /** Another backend: the same key, an installation of its own there, and the same personal measurements. */
  const choose = (name: string) => {
    const enabled = trust.personalMeasurements;
    trust.close();
    trustRef.current = setUpDeviceTrust(backends[name], enabled);
    apiRef.current = new SampleApi(trustRef.current);
    setBackend(name);
    setScan(null);
    setLatest({});
  };

  /** Runs one action of [section] and shows how the backend answered it. */
  const run = async (section: string, action: string, step: () => Promise<string>, expect: Expect = 'accepted') => {
    setBusy(true);
    let outcome: Outcome;
    try {
      const answer = await step();
      outcome =
        expect === 'accepted'
          ? { action, text: answer, asExpected: true }
          : { action, text: `Accepted, but a backend should refuse this: ${answer}`, asExpected: false };
    } catch (error) {
      if (error instanceof ApiException) {
        const refusal = `${error.statusCode ?? ''} ${error.code ?? ''}`.trim();
        // A session the backend no longer takes says nothing of the check a request was made wrong
        // to test: the sample's session lasts ten minutes.
        const sessionGone = error.code === 'expired_token' || error.code === 'not_signed_in';
        outcome =
          expect === 'refused' && !sessionGone
            ? { action, text: `Refused, as it should be: ${refusal}`, asExpected: true }
            : {
                action,
                text: sessionGone
                  ? `Refused: ${refusal}. The session is no longer valid: sign in again.`
                  : `Refused: ${refusal}. ${error.message}`,
                asExpected: false,
              };
      } else if (error instanceof NativeKeyException) {
        outcome = { action, text: `The phone said ${error.code}: ${error.message}`, asExpected: false };
      } else {
        outcome = { action, text: String(error instanceof Error ? error.message : error), asExpected: false };
      }
    }
    // Also to the device log, for whoever runs a test.
    console.log(`EXAMPLE: [${backend}] ${action} — ${outcome.text}`);
    setBusy(false);
    setLatest((current) => ({ ...current, [section]: outcome }));
    setLog((current) => [outcome, ...current]);
  };

  // --- The installation.

  const start = async (): Promise<string> => {
    const identity = await trustRef.current.start();
    const stepUpOff = trustRef.current.stepUpUnavailable;
    return `Installation ${identity.installationId}, proved; step-up ${
      stepUpOff === null ? 'on' : `off here (${stepUpOff.code})`
    }.`;
  };

  const prove = async (): Promise<string> => {
    await trust.prove();
    return 'A new installation session.';
  };

  const newInstallation = () => {
    Alert.alert(
      'A new installation?',
      'This deletes the installation key, its ID and the step-up key, as a reinstall would, and starts again with new keys.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start again',
          onPress: () =>
            void run('Installation', 'New installation', async () => {
              await trust.reset();
              api.account = null;
              setScan(null);
              return start();
            }),
        },
      ],
    );
  };

  // --- The scan.

  const setPersonal = (enabled: Set<PersonalMeasurement>) => {
    trust.personalMeasurements = enabled;
    refresh();
  };

  const askLocation = async (): Promise<string> => {
    const permission = await trust.requestLocationPermission();
    setLocationPermission(permission);
    return `The app holds: ${permission}.`;
  };

  const doScan = async (): Promise<string> => {
    const result = await trust.scan();
    setScan(result);
    const integrity = result.answer['integrity'];
    const next = typeof integrity === 'object' && integrity !== null ? (integrity as Record<string, unknown>)['next'] : null;
    return `The backend answered next: ${next ?? 'not said'}, report ${result.reportId ?? 'not named'}.`;
  };

  // --- The screen.

  const started = trust.installationSession !== null;
  const signedIn = api.account !== null;
  const enabled = trust.personalMeasurements;
  const identity = trust.identity;
  const stepUp = trust.stepUpKey;
  const stepUpOff = trust.stepUpUnavailable;
  const locationOn = enabled.has(PersonalMeasurement.location) || enabled.has(PersonalMeasurement.mockLocation);

  const button = (
    section: string,
    label: string,
    step: () => Promise<string>,
    options: { enabled?: boolean; primary?: boolean; expect?: Expect } = {},
  ) => {
    const disabled = busy || options.enabled === false;
    const refused = options.expect === 'refused';
    return (
      <Pressable
        key={label}
        disabled={disabled}
        accessibilityRole="button"
        onPress={() => void run(section, label, step, options.expect)}
        style={[
          styles.button,
          refused ? styles.outlined : options.primary ? styles.filled : styles.tonal,
          disabled && styles.disabled,
        ]}>
        <Text style={[styles.buttonText, !refused && options.primary ? styles.filledText : null]}>{label}</Text>
      </Pressable>
    );
  };

  const plain = (label: string, onPress: () => void, isEnabled: boolean) => (
    <Pressable
      key={label}
      disabled={busy || !isEnabled}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, styles.outlined, (busy || !isEnabled) && styles.disabled]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  const refusal = (label: string, step: () => Promise<unknown>, isEnabled: boolean) =>
    button('Refusals', label, async () => JSON.stringify(await step()), { enabled: isEnabled, expect: 'refused' });

  const latestLine = (section: string) => (latest[section] ? <OutcomeLine outcome={latest[section]} /> : null);

  return (
    <View style={styles.page}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.appBar}>
        <Text style={styles.appTitle}>Necessary</Text>
        {busy ? <ActivityIndicator color={colors.primary} /> : null}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {names.length > 1 ? (
          <View style={styles.segments}>
            {names.map((name) => (
              <Pressable
                key={name}
                disabled={busy}
                onPress={() => choose(name)}
                style={[styles.segment, name === backend && styles.segmentOn]}>
                <Text style={[styles.buttonText, name === backend && styles.filledText]}>{name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={styles.small}>Backend: {backends[backend]}</Text>

        <Section
          title="Installation"
          subtitle={started ? 'Its key made, registered and proved' : 'Start: make the key, register it, prove it'}
          initiallyOpen>
          <View style={styles.actions}>
            {button('Installation', started ? 'Start again' : 'Start', start, { primary: true })}
            {button('Installation', 'Prove again', prove, { enabled: started })}
            {plain('New installation', newInstallation, identity !== null)}
          </View>
          {latestLine('Installation')}
          {identity !== null ? (
            <>
              <Field label="Installation ID" value={identity.installationId} />
              <Field label="Key thumbprint" value={identity.keyThumbprint} />
              <Field label="Key" value={`${identity.algorithm}, ${identity.provider}, ${identity.securityLevel}`} />
              <Field label="Hardware-backed" value={identity.hardwareBacked ? 'yes' : 'no'} />
              <Field label="Can leave the phone" value={identity.privateKeyExportable ? 'yes' : 'no'} />
              <Field label="New this launch" value={identity.createdThisLaunch ? 'yes' : 'no'} />
              <Field
                label="Step-up key"
                value={
                  stepUp !== null
                    ? `${stepUp.description}, ${stepUp.securityLevel}`
                    : stepUpOff !== null
                      ? `off on this phone: ${stepUpOff.code}`
                      : 'made at start'
                }
              />
            </>
          ) : null}
        </Section>

        <Section
          title="Measurements"
          subtitle={
            scan === null
              ? 'What the phone measures, signed with its key'
              : `${Object.keys(scan.report.report['probe_results'] as object).length} sent in the last scan`
          }>
          <Text style={styles.subTitle}>Personal measurements</Text>
          <Note text="Measured only when this app turns one on and the backend asks for it. None is on until the app says so." />
          <SwitchRow
            title="All of them"
            value={enabled.size === personalMeasurements.length}
            disabled={busy}
            onChange={(on) => setPersonal(new Set(on ? personalMeasurements : []))}
          />
          {personalMeasurements.map((measurement) => (
            <SwitchRow
              key={measurement}
              title={personalInfo(measurement).title}
              subtitle={personalInfo(measurement).about}
              value={enabled.has(measurement)}
              disabled={busy}
              onChange={(on) => {
                const next = new Set(enabled);
                if (on) next.add(measurement);
                else next.delete(measurement);
                setPersonal(next);
              }}
            />
          ))}
          <Code text={personalCode(enabled)} />
          {locationOn ? (
            <View style={styles.actions}>
              {button(
                'Measurements',
                locationPermission === null ? 'Ask for the location permission' : `Location permission: ${locationPermission}`,
                askLocation,
              )}
            </View>
          ) : null}
          <View style={styles.actions}>{button('Measurements', 'Scan', doScan, { enabled: started, primary: true })}</View>
          {latestLine('Measurements')}
          {scan !== null ? (
            <ScanView
              platform={scan.challenge.platform}
              required={scan.challenge.requiredProbes}
              optional={scan.challenge.optionalProbes}
              results={scan.report.report['probe_results'] as Record<string, unknown>}
              enabled={scan.report.report['enabled_measurements'] as string[]}
            />
          ) : null}
        </Section>

        <Section title="Account" subtitle={signedIn ? 'Signed in' : 'Sign in to the sample backend'}>
          <Label text="Handle" />
          <TextInput style={styles.input} value={handle} onChangeText={setHandle} autoCorrect={false} autoCapitalize="none" />
          <Label text="Password" />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCorrect={false}
            autoCapitalize="none"
            onFocus={() => typingSecret(true)}
            onBlur={() => typingSecret(false)}
          />
          <Note text="The sample makes the account at its first sign-in" />
          <View style={styles.actions}>
            {button(
              'Account',
              'Sign in',
              async () => {
                await api.signIn(handle, password);
                return 'An account session for this installation.';
              },
              { enabled: started, primary: true },
            )}
            {plain(
              'Sign out',
              () => {
                api.account = null;
                refresh();
              },
              signedIn,
            )}
          </View>
          {latestLine('Account')}
        </Section>

        <Section title="Requests" subtitle="A proof on each; the person's approval on a sensitive one">
          <Note text="Each request carries a proof signed by this installation's key. The sensitive one also needs the person's approval: the step-up key, unlocked with the screen lock, or the app PIN." />
          <View style={styles.actions}>
            {button('Requests', 'Protected request', async () => JSON.stringify(await api.protectedRequest()), {
              enabled: signedIn,
            })}
            {button('Requests', 'Sensitive, without approval', async () => JSON.stringify(await api.sensitive()), {
              enabled: signedIn,
              expect: 'refused',
            })}
            {button('Requests', 'Sensitive, with step-up', async () => JSON.stringify(await api.sensitive({ stepUp: true })), {
              enabled: signedIn,
            })}
            {button('Requests', 'Re-enrol the step-up key', async () => JSON.stringify(await api.reenrolStepUp(password)), {
              enabled: signedIn,
            })}
          </View>
          <Label text="App PIN (6 digits)" />
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            autoCorrect={false}
            onFocus={() => typingSecret(true)}
            onBlur={() => typingSecret(false)}
          />
          <Note text="The screen is protected while it is typed" />
          <View style={styles.actions}>
            {button(
              'Requests',
              'Set the app PIN',
              async () => {
                await api.setAppPin(pin, password);
                return 'Set, with the account password.';
              },
              { enabled: signedIn },
            )}
            {button('Requests', 'Sensitive, with the app PIN', async () => JSON.stringify(await api.sensitive({ appPin: pin })), {
              enabled: signedIn,
            })}
          </View>
          {latestLine('Requests')}
        </Section>

        <Section title="Requests a backend must refuse" subtitle="Made wrong on purpose">
          <Note text="Each of these is a request made wrong on purpose. A backend that makes the guide's checks refuses every one." />
          <View style={styles.actions}>
            {refusal('Send one request twice', () => api.replay(), signedIn)}
            {refusal('Change the body after signing', () => api.changedBody(), signedIn)}
            {refusal('Send it to another path', () => api.otherPath(), signedIn)}
            {refusal('A proof ten minutes old', () => api.staleProof(), signedIn)}
          </View>
          <Text style={styles.subTitle}>A session copied to another phone</Text>
          <Note text="Share this phone's session, get it to another phone running this example, paste it there and use it: that phone's key cannot sign for this installation." />
          <View style={styles.actions}>
            {plain("Share this phone's session", () => void Share.share({ message: api.shareSession() }), signedIn)}
          </View>
          <Label text="A session from another phone" />
          <TextInput style={styles.input} value={shared} onChangeText={setShared} multiline autoCorrect={false} autoCapitalize="none" />
          <View style={styles.actions}>
            {refusal('Use it here', () => api.sessionFromAnotherPhone(shared), started && shared.trim().length > 0)}
          </View>
          {latestLine('Refusals')}
        </Section>

        <Section title="Log" subtitle={`${log.length} results, the latest first`}>
          {log.map((outcome, index) => (
            <OutcomeLine key={index} outcome={outcome} />
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

/** The code for the personal measurements chosen above. */
function personalCode(enabled: Set<PersonalMeasurement>): string {
  if (enabled.size === 0) return 'trust.personalMeasurements = new Set();';
  const entries = Object.entries(PersonalMeasurement)
    .filter(([, value]) => enabled.has(value))
    .map(([name]) => `  PersonalMeasurement.${name},`);
  return ['trust.personalMeasurements = new Set([', ...entries, ']);'].join('\n');
}

// --- Pieces of the screen.

function Section(props: { title: string; subtitle: string; initiallyOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  return (
    <View style={styles.card}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" style={styles.cardHeader}>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>{props.title}</Text>
          <Text style={styles.small}>{props.subtitle}</Text>
        </View>
        <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {/* Every section stays built, so each keeps what it shows while closed. */}
      <View style={[styles.cardBody, !open && styles.hidden]}>{props.children}</View>
    </View>
  );
}

function OutcomeLine(props: { outcome: Outcome }) {
  const { outcome } = props;
  return (
    <View style={styles.outcome}>
      <Text style={{ color: outcome.asExpected ? colors.primary : colors.error }}>{outcome.asExpected ? '✓' : '!'}</Text>
      <Text selectable style={[styles.flex, styles.outcomeText]}>
        {outcome.action}: {outcome.text}
      </Text>
    </View>
  );
}

function Field(props: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <Text selectable style={styles.fieldValue}>
        {props.value}
      </Text>
    </View>
  );
}

function SwitchRow(props: { title: string; subtitle?: string; value: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text style={styles.switchTitle}>{props.title}</Text>
        {props.subtitle ? <Text style={styles.small}>{props.subtitle}</Text> : null}
      </View>
      <Switch value={props.value} disabled={props.disabled} onValueChange={props.onChange} />
    </View>
  );
}

const Note = (props: { text: string }) => <Text style={[styles.small, styles.note]}>{props.text}</Text>;
const Label = (props: { text: string }) => <Text style={styles.label}>{props.text}</Text>;
const Code = (props: { text: string }) => (
  <Text selectable style={styles.code}>
    {props.text}
  </Text>
);

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  appBar: {
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
  },
  appTitle: { fontSize: 22, fontWeight: '600', color: colors.text },
  content: { padding: 12, paddingBottom: 48 },
  flex: { flex: 1 },
  hidden: { display: 'none' },
  small: { fontSize: 12, color: colors.muted },
  note: { marginBottom: 4 },
  subTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 8 },
  label: { fontSize: 12, color: colors.muted, marginTop: 8 },
  card: { backgroundColor: colors.surface, borderRadius: 12, marginTop: 10, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  cardBody: { paddingHorizontal: 16, paddingBottom: 16 },
  chevron: { fontSize: 18, color: colors.muted, marginLeft: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 8 },
  button: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, marginRight: 8, marginBottom: 8 },
  filled: { backgroundColor: colors.primary },
  tonal: { backgroundColor: colors.tonal },
  outlined: { borderWidth: 1, borderColor: colors.outline },
  disabled: { opacity: 0.4 },
  buttonText: { fontSize: 14, color: colors.text },
  filledText: { color: colors.primaryText },
  segments: { flexDirection: 'row', marginBottom: 4 },
  segment: { flex: 1, padding: 8, borderWidth: 1, borderColor: colors.outline, alignItems: 'center' },
  segmentOn: { backgroundColor: colors.primary },
  outcome: { flexDirection: 'row', paddingVertical: 4 },
  outcomeText: { marginLeft: 8, fontSize: 13, color: colors.text },
  field: { flexDirection: 'row', paddingVertical: 2 },
  fieldLabel: { flex: 2, fontWeight: '600', fontSize: 13, color: colors.text },
  fieldValue: { flex: 3, fontSize: 13, color: colors.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  switchTitle: { fontSize: 14, color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.text,
    marginTop: 4,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 12,
    backgroundColor: colors.code,
    padding: 10,
    borderRadius: 8,
    marginVertical: 8,
    color: colors.text,
  },
});
