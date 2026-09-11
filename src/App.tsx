import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import './App.css';
import LibraryScreen from './screens/LibraryScreen';
import ReaderScreen from './screens/ReaderScreen';
import type { LibraryFile } from './lib/libraryFolder';

type Screen = { name: 'library' } | { name: 'reader'; file: LibraryFile };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'library' });
  const screenRef = useRef(screen);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const listenerPromise = CapacitorApp.addListener('backButton', () => {
      if (screenRef.current.name === 'reader') {
        console.log('[App] hardware back button: leaving reader, returning to library');
        setScreen({ name: 'library' });
      } else {
        console.log('[App] hardware back button: already at library, exiting app');
        CapacitorApp.exitApp();
      }
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, []);

  if (screen.name === 'reader') {
    return <ReaderScreen file={screen.file} onBack={() => setScreen({ name: 'library' })} />;
  }

  return <LibraryScreen onOpenBook={(file) => setScreen({ name: 'reader', file })} />;
}

export default App;
