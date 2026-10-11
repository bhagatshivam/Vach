package com.vach.reader;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Log.d(TAG, "onCreate() registering LibraryFolderPlugin before super.onCreate()");
        registerPlugin(LibraryFolderPlugin.class);
        super.onCreate(savedInstanceState);
        Log.d(TAG, "onCreate() done, bridge=" + getBridge());
    }
}
