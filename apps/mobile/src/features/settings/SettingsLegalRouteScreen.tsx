import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  // Fork: Settings hides the Legal row without a configured site; a `settings/legal` link lands here.
  if (!LEGAL_URL) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-8">
        <Text className="text-center text-base text-foreground-muted">
          This build links to no legal documents.
        </Text>
      </View>
    );
  }
  return <SettingsLegalDocumentRouteScreen documentName="Legal" documentUrl={LEGAL_URL} />;
}
