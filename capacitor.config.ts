import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.assetslicer.app',
  appName: 'Asset Slicer',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: false
    }
  }
};

export default config;
