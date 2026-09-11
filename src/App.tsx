import { useState } from 'react';
import './App.css';
import LibraryScreen from './screens/LibraryScreen';
import ReaderScreen from './screens/ReaderScreen';
import type { LibraryFile } from './lib/libraryFolder';

type Screen = { name: 'library' } | { name: 'reader'; file: LibraryFile };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'library' });

  if (screen.name === 'reader') {
    return <ReaderScreen file={screen.file} onBack={() => setScreen({ name: 'library' })} />;
  }

  return <LibraryScreen onOpenBook={(file) => setScreen({ name: 'reader', file })} />;
}

export default App;
