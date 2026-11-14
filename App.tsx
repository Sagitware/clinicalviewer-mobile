import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import { File } from 'expo-file-system';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { StudySummary } from './src/lib/dicomClient';
import {
  LOCAL,
  deleteServer,
  loadLocation,
  loadServers,
  newServer,
  saveLocation,
  saveServer,
  serverLabel,
  type ServerConfig,
} from './src/lib/settings';
import type { CloudProvider } from './src/lib/cloud/types';
import { readIncomingFile, useIncomingFiles } from './src/lib/incomingFiles';
import { saveInstances, listSeries, loadSeriesFiles, type SavedStudy } from './src/lib/localDb';
import { importDicomBuffers, importFromUrl, importLocalFiles, type LocalImportResult, type SliceSource } from './src/lib/sources';
import { createStudyServer } from './src/lib/studyServer';
import { LocationMenu } from './src/components/LocationMenu';
import { CloudBrowserScreen } from './src/screens/CloudBrowserScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { ImportScreen } from './src/screens/ImportScreen';
import { SeriesListScreen, type SeriesItem } from './src/screens/SeriesListScreen';
import { ServerScreen } from './src/screens/ServerScreen';
import { ServersScreen } from './src/screens/ServersScreen';
import { StudyListScreen } from './src/screens/StudyListScreen';
import { ViewerScreen } from './src/screens/ViewerScreen';
import { colors } from './src/theme';

// Completes the Dropbox OAuth redirect when the app is reopened by the browser.
WebBrowser.maybeCompleteAuthSession();

/** Simple view-state navigation, the same model as the ClinicalView web app. */
type Route =
  // Local studies or the chosen server's studies, depending on the location.
  | { name: 'home' }
  | { name: 'servers' }
  | { name: 'server'; server: ServerConfig; isNew: boolean; selectOnSave?: boolean }
  | { name: 'import' }
  | { name: 'cloud'; provider: CloudProvider }
  | {
      name: 'series';
      title: string;
      subtitle?: string;
      backLabel?: string;
      load: () => Promise<{ items: SeriesItem[]; notice?: string }>;
    }
  | { name: 'viewer'; source: SliceSource; backLabel: string };

export default function App() {
  const [servers, setServers] = useState<ServerConfig[] | null>(null);
  // LOCAL or a server id; an id that no longer exists falls back to Local studies.
  const [location, setLocation] = useState(LOCAL);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];

  const push = useCallback((r: Route) => setStack((s) => [...s, r]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  useEffect(() => {
    Promise.all([loadServers(), loadLocation()]).then(([s, l]) => {
      setServers(s);
      setLocation(l);
    });
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, pop]);

  const server = servers?.find((s) => s.id === location) ?? null;
  const client = useMemo(() => (server ? createStudyServer(server) : null), [server]);

  const chooseLocation = useCallback((next: string) => {
    setLocation(next);
    saveLocation(next);
    setStack([{ name: 'home' }]);
  }, []);

  const openStudy = useCallback(
    (study: StudySummary) => {
      if (!client) return;
      push({
        name: 'series',
        title: study.patientName,
        subtitle: [study.studyDate, study.description].filter(Boolean).join('   '),
        backLabel: 'Studies',
        load: async () => ({
          items: (await client.searchSeries(study.studyUID)).map((s) => ({
            key: s.seriesUID,
            modality: s.modality,
            title: s.description || `Series ${s.number ?? ''}`.trim(),
            detail: [s.number != null && `Series ${s.number}`, s.instanceCount != null && `${s.instanceCount} images`]
              .filter(Boolean)
              .join('   '),
            open: () => client.openSeries(study, s),
          })),
        }),
      });
    },
    [client, push],
  );

  const openSavedStudy = useCallback(
    (study: SavedStudy) =>
      push({
        name: 'series',
        title: study.patientName,
        subtitle: [study.studyDate, study.description].filter(Boolean).join('   '),
        backLabel: 'Local',
        load: async () => ({
          items: (await listSeries(study.studyUid)).map((s) => ({
            key: s.seriesUid,
            modality: s.modality,
            title: s.description || `Series ${s.number ?? ''}`.trim() || 'Untitled series',
            detail: [s.number != null && `Series ${s.number}`, `${s.instanceCount} images`].filter(Boolean).join('   '),
            open: async () => {
              const { series } = importDicomBuffers(await loadSeriesFiles(s.seriesUid));
              if (series.length === 0) throw new Error('The stored images could not be read.');
              return series[0].source;
            },
          })),
        }),
      }),
    [push],
  );

  /** Shows imported series; on the way, the import and cloud screens are replaced so Back returns to Studies. */
  const showImport = useCallback((result: Promise<LocalImportResult>, title: string, subtitle: string) => {
    const route: Route = {
      name: 'series',
      title,
      subtitle,
      load: async () => {
        const { series, skipped, instances } = await result;
        if (series.length === 0) {
          const reasons = skipped.slice(0, 3).map((s) => `${s.name}: ${s.reason}`).join('\n');
          throw new Error(`None of the selected files could be displayed.\n${reasons}`);
        }
        let saveNotice: string | undefined;
        try {
          const saved = await saveInstances(instances ?? []);
          saveNotice = `${saved} image${saved === 1 ? '' : 's'} saved to Local studies.`;
        } catch {
          saveNotice = 'Could not save to Local studies on this device.';
        }
        return {
          items: series.map((s) => ({
            key: s.uid,
            modality: s.modality,
            title: s.description || 'Untitled series',
            detail: `${s.source.count} image${s.source.count === 1 ? '' : 's'}`,
            open: async () => s.source,
          })),
          notice: [
            saveNotice,
            skipped.length
              ? `${skipped.length} file${skipped.length === 1 ? ' was' : 's were'} skipped (not DICOM, compressed, or unreadable).`
              : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        };
      },
    };
    setStack((s) => [...s.filter((r) => r.name !== 'import' && r.name !== 'cloud'), route]);
  }, []);

  const pickDeviceFiles = useCallback(async () => {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
    if (picked.canceled || picked.assets.length === 0) return;
    const files = picked.assets.map((a) => ({ uri: a.uri, name: a.name }));
    const result = importLocalFiles(files).finally(() => {
      // Pixels now live in memory only; remove the picker's cached copies.
      for (const f of files) {
        try {
          new File(f.uri).delete();
        } catch {
          // Not a cache copy, or already gone.
        }
      }
    });
    showImport(result, 'Files on this device', `${files.length} file${files.length === 1 ? '' : 's'} selected`);
  }, [showImport]);

  const importUrl = useCallback(
    (url: string) => {
      const host = (() => {
        try {
          return new URL(url.trim()).host;
        } catch {
          return url.trim();
        }
      })();
      showImport(importFromUrl(url), 'From link', host);
    },
    [showImport],
  );

  // Attachments opened with "Open in fig-dicom" from Mail, Gmail, Files, and similar apps.
  useIncomingFiles((url, name) => showImport(readIncomingFile(url), 'Opened file', name));

  const addServer = useCallback(
    (selectOnSave: boolean) => push({ name: 'server', server: newServer(), isNew: true, selectOnSave }),
    [push],
  );

  const storeServer = useCallback(
    async (s: ServerConfig, selectOnSave?: boolean) => {
      setServers(await saveServer(s, servers ?? []));
      if (selectOnSave) chooseLocation(s.id);
      else pop();
    },
    [servers, chooseLocation, pop],
  );

  const removeServer = useCallback(
    async (id: string) => {
      setServers(await deleteServer(id, servers ?? []));
      if (location === id) {
        setLocation(LOCAL);
        saveLocation(LOCAL);
      }
      pop();
    },
    [servers, location, pop],
  );

  let screen: React.ReactNode;
  if (!servers) {
    screen = <ActivityIndicator style={styles.boot} color={colors.accent} />;
  } else if (route.name === 'home') {
    screen =
      server && client ? (
        <StudyListScreen
          key={server.id}
          title={serverLabel(server)}
          client={client}
          onOpenStudy={openStudy}
          onSwitchLocation={() => setMenuOpen(true)}
          onOpenFiles={() => push({ name: 'import' })}
          onServers={() => push({ name: 'servers' })}
          onEditServer={() => push({ name: 'server', server, isNew: false })}
        />
      ) : (
        <LibraryScreen
          onOpenStudy={openSavedStudy}
          onSwitchLocation={() => setMenuOpen(true)}
          onOpenFiles={() => push({ name: 'import' })}
          onServers={() => push({ name: 'servers' })}
        />
      );
  } else if (route.name === 'servers') {
    screen = (
      <ServersScreen
        servers={servers}
        onEdit={(s) => push({ name: 'server', server: s, isNew: false })}
        onAdd={() => addServer(false)}
        onBack={pop}
      />
    );
  } else if (route.name === 'server') {
    screen = (
      <ServerScreen
        key={route.server.id}
        server={route.server}
        isNew={route.isNew}
        onSave={(s) => storeServer(s, route.selectOnSave)}
        onDelete={removeServer}
        onBack={pop}
      />
    );
  } else if (route.name === 'import') {
    screen = (
      <ImportScreen
        onBack={pop}
        onPickDevice={pickDeviceFiles}
        onImportUrl={importUrl}
        onOpenCloud={(provider) => push({ name: 'cloud', provider })}
      />
    );
  } else if (route.name === 'cloud') {
    screen = (
      <CloudBrowserScreen
        provider={route.provider}
        onBack={pop}
        onImported={(result, label) => showImport(Promise.resolve(result), route.provider.label, label)}
      />
    );
  } else if (route.name === 'series') {
    screen = (
      <SeriesListScreen
        title={route.title}
        subtitle={route.subtitle}
        backLabel={route.backLabel ?? 'Back'}
        load={route.load}
        onBack={pop}
        onOpen={(source) => push({ name: 'viewer', source, backLabel: 'Series' })}
      />
    );
  } else {
    screen = <ViewerScreen source={route.source} backLabel={route.backLabel} onBack={pop} />;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View style={styles.root}>{screen}</View>
        <LocationMenu
          visible={menuOpen}
          location={server ? server.id : LOCAL}
          servers={servers ?? []}
          onSelect={chooseLocation}
          onAddServer={() => addServer(true)}
          onManageServers={() => push({ name: 'servers' })}
          onClose={() => setMenuOpen(false)}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  boot: { flex: 1 },
});
