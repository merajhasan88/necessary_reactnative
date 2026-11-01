// Reading a scan: every measurement the signed report carried, each with its status and its fields
// as the phone sent them, grouped by what it catches -- the hooks, gadgets and changes in memory
// first. A measurement the backend did not ask for shows as not asked rather than disappearing.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { androidMeasurements, groups, iosMeasurements, personalCatalog, type MeasurementInfo } from './measurements';
import { colors } from './theme';

type Fields = Record<string, unknown>;

/** A measurement's status as the badge says it: whether the phone measured it, never whether what it found is good or bad. */
const statusLabels: Record<string, string> = { ok: 'measured', error: 'failed', not_enabled: 'off' };

function isMap(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(scalar).join(', ');
  if (isMap(value)) return 'none';
  const text = String(value);
  return text.length === 0 ? '""' : text;
}

/** Every field of [fields], nested maps and lists indented under their name. */
function fieldRows(fields: Fields, depth = 0, prefix = ''): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const key = `${prefix}${depth}:${name}`;
    if (isMap(value) && Object.keys(value).length > 0) {
      rows.push(<FieldRow key={key} name={name} depth={depth} />);
      rows.push(...fieldRows(value, depth + 1, key));
    } else if (Array.isArray(value) && value.some(isMap)) {
      rows.push(<FieldRow key={key} name={name} value={String(value.length)} depth={depth} />);
      value.forEach((item, index) => {
        if (isMap(item)) {
          const numbered: Fields = {};
          for (const [itemName, itemValue] of Object.entries(item)) numbered[`${index + 1}. ${itemName}`] = itemValue;
          rows.push(...fieldRows(numbered, depth + 1, `${key}:${index}`));
        } else {
          rows.push(<FieldRow key={`${key}:${index}`} name={`${index + 1}.`} value={scalar(item)} depth={depth + 1} />);
        }
      });
    } else {
      rows.push(<FieldRow key={key} name={name} value={scalar(value)} depth={depth} />);
    }
  }
  return rows;
}

function FieldRow(props: { name: string; value?: string; depth: number }) {
  return (
    <View style={[styles.fieldRow, { paddingLeft: 12 * props.depth }]}>
      <Text style={[styles.small, styles.fieldName]}>{props.name}</Text>
      <Text selectable style={[styles.small, styles.fieldValue]}>
        {props.value ?? ''}
      </Text>
    </View>
  );
}

function Badge(props: { label: string; warning?: boolean }) {
  const color = props.warning ? colors.error : props.label === 'measured' ? colors.primary : colors.outline;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{props.label}</Text>
    </View>
  );
}

/** One measurement: its title and status, opening to what it tells a backend and every field the phone sent. */
function MeasurementTile(props: { info: MeasurementInfo; result: Fields | null; asked: boolean }) {
  const [open, setOpen] = useState(false);
  const { info, result, asked } = props;
  const unread = result?.['unread'];
  const partly = isMap(unread) && Object.keys(unread).length > 0;
  const status =
    result === null ? (asked ? 'missing' : 'not asked') : typeof result['status'] === 'string' ? (result['status'] as string) : 'no status';
  const rest: Fields = {};
  if (result !== null) for (const [name, value] of Object.entries(result)) if (name !== 'status') rest[name] = value;
  return (
    <View style={styles.tile}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <View style={styles.tileHeader}>
          <Text style={styles.tileTitle}>{info.title}</Text>
          {partly ? <Badge label="unread" warning /> : null}
          {result?.['truncated'] === true ? <Badge label="truncated" /> : null}
          <Badge
            label={statusLabels[status] ?? status}
            warning={status === 'error' || status === 'missing' || (status === 'not asked' && info.group === 'hooks')}
          />
        </View>
        <Text style={styles.mono}>{info.name}</Text>
      </Pressable>
      {open ? (
        <View style={styles.tileBody}>
          <Text style={styles.small}>{info.about}</Text>
          {result === null ? (
            <Text style={styles.small}>
              {asked
                ? 'Asked for, but not in the report: a backend refuses such a report.'
                : 'Not asked for in this scan, so not measured.'}
            </Text>
          ) : (
            <>
              {result['status'] === 'not_enabled' ? (
                <Text style={styles.small}>The backend asked; this app has not turned it on.</Text>
              ) : null}
              {partly ? (
                <Text style={[styles.small, { color: colors.error }]}>
                  Parts it could not read are not measured: never read them as a clean "no".
                </Text>
              ) : null}
              {fieldRows(rest)}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One scan as the phone sent it: the backend's plan -- [required] and the personal measurements it
 * asked for, [optional] -- and the report's [results] (`probe_results`).
 */
export function ScanView(props: {
  platform: string;
  required: string[];
  optional: string[];
  results: Fields;
  enabled: string[];
}) {
  const { platform, required, optional, results, enabled } = props;
  const catalog = [...(platform === 'ios' ? iosMeasurements : androidMeasurements), ...personalCatalog];
  const tile = (info: MeasurementInfo) => (
    <MeasurementTile
      key={info.name}
      info={info}
      result={isMap(results[info.name]) ? (results[info.name] as Fields) : null}
      asked={required.includes(info.name) || optional.includes(info.name)}
    />
  );
  const other = Object.keys(results).filter((name) => !catalog.some((info) => info.name === name));
  return (
    <View>
      <Text style={[styles.small, styles.italic]}>
        The phone reports what it measured; your backend decides what it means.
      </Text>
      {groups.map((group) => {
        const members = catalog.filter(
          (info) =>
            info.group === group.name &&
            (group.name !== 'personal' || optional.includes(info.name) || info.name in results),
        );
        return (
          <View key={group.name} style={styles.group}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            <Text style={styles.small}>
              {group.name === 'personal'
                ? `${group.note} On: ${enabled.length === 0 ? 'none' : enabled.join(', ')}.`
                : group.note}
            </Text>
            {members.map(tile)}
            {members.length === 0 ? <Text style={styles.small}>The backend asked for none.</Text> : null}
          </View>
        );
      })}
      {other.length > 0 ? (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Other measurements</Text>
          <Text style={styles.small}>In the report as sent.</Text>
          {other.map((name) => tile({ name, title: name, about: 'Not described here.', group: 'device' }))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 12, color: colors.text },
  italic: { fontStyle: 'italic' },
  mono: { fontFamily: 'monospace', fontSize: 12, color: colors.muted },
  group: { marginTop: 12 },
  groupTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  tile: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.outline },
  tileHeader: { flexDirection: 'row', alignItems: 'center' },
  tileTitle: { flex: 1, fontSize: 14, color: colors.text },
  tileBody: { paddingTop: 4, paddingBottom: 8 },
  fieldRow: { flexDirection: 'row', paddingVertical: 2 },
  fieldName: { flex: 5, fontWeight: '600' },
  fieldValue: { flex: 6, marginLeft: 8 },
  badge: { marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1, borderWidth: 1, borderRadius: 10 },
  badgeText: { fontSize: 11 },
});
