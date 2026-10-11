import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vach.reader',
  appName: 'Vach',
  webDir: 'dist',
  // This app makes zero network calls by design. Explicitly off (it already
  // defaults to false) so the override-fetch/XMLHttpRequest behavior never
  // turns on even if that default ever changes upstream. Note this flag
  // alone isn't the network guarantee - CapacitorHttp's native plugin is
  // registered unconditionally regardless of this setting, and is only
  // actually blocked by removing android.permission.INTERNET from the
  // manifest (see AndroidManifest.xml).
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;
