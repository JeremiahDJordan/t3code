import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * The npm package whose versions a self-updating server downloads, as a registry URL such as
 * `https://registry.npmjs.org/<name>`. The fork checks no registry unless its owner configures
 * one at build time (FORK.md, "Talk to no T3 web service"); without it every version counts as
 * published and a server's own download reports a missing release.
 */
function configuredNpmPackageUrl(): string | undefined {
  const url = (import.meta.env.VITE_T3CODE_NPM_PACKAGE_URL as string | undefined)?.trim();
  return url ? url.replace(/\/+$/, "") : undefined;
}

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const packageUrl = configuredNpmPackageUrl();
      if (packageUrl === undefined) return true;
      const response = yield* HttpClient.get(`${packageUrl}/${encodeURIComponent(version)}`);
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      return typeof body === "object" && body !== null && "version" in body
        ? body.version === version
        : false;
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight, which npm rejects.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
