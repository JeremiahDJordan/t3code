import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { LoadingStrip } from "../../components/LoadingStrip";
import {
  webViewRequestsLackRouteHeaders,
  withEnvironmentRequestHeaders,
} from "../../lib/environmentRequest";

export function WorkspaceFileWebPreview(props: {
  readonly uri: string | null;
  /** An HTML workspace file, which may link styles, images and scripts beside it. */
  readonly linksWorkspaceFiles?: boolean;
}) {
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (props.uri === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }
  // The page itself loads, but the files it links may not; say so rather than show it broken.
  const linkedFilesMayFail =
    props.linksWorkspaceFiles === true && webViewRequestsLackRouteHeaders(props.uri);

  return (
    <View className="relative flex-1 bg-card">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      {loadError ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Preview failed</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
        </View>
      ) : null}
      {linkedFilesMayFail ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Linked files may not load</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">
            Cloudflare Access may refuse the styles, images and scripts this page links. An
            end-to-end encrypted route shows them.
          </Text>
        </View>
      ) : null}
      <WebView
        source={withEnvironmentRequestHeaders({ uri: props.uri })}
        originWhitelist={["*"]}
        allowsBackForwardNavigationGestures
        allowsFullscreenVideo
        setSupportMultipleWindows={false}
        startInLoadingState
        onLoadProgress={(event) => {
          setLoadProgress(event.nativeEvent.progress);
        }}
        onLoadStart={() => {
          setLoadProgress(0.05);
          setLoadError(null);
        }}
        onLoadEnd={() => {
          setLoadProgress(0);
        }}
        onError={(event) => {
          setLoadProgress(0);
          setLoadError(event.nativeEvent.description || "The file could not be rendered.");
        }}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-card">
            <AppActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
