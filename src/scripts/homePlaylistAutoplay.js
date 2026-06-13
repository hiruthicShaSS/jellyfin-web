import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getUserViewsApi } from '@jellyfin/sdk/lib/utils/api/user-views-api';

import { appRouter } from 'components/router/appRouter';
import { playbackManager } from 'components/playback/playbackmanager';
import toast from 'components/toast/toast';
import {
    AUTOPLAY_PLAYLIST_NAME,
    AUTOPLAY_TOAST_MESSAGE,
    AUTOPLAY_USERNAME
} from 'config/homePlaylistAutoplayConfig';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';

const AUTOPLAY_BUILD_MARKER = 'home-playlist-autoplay-v3';

let autoplaySequenceActive = false;

console.info(`[HomePlaylistAutoplay] Loaded ${AUTOPLAY_BUILD_MARKER}`);

function normalizeName(value) {
    return (value || '').trim().toLowerCase();
}

function isTargetUser(user) {
    return normalizeName(user?.Name) === normalizeName(AUTOPLAY_USERNAME);
}

function isHomePageElement(element) {
    return element?.id === 'indexPage' || element?.classList?.contains('homePage');
}

function isOnHomeRoute() {
    const hash = window.location.hash || '';
    return hash === '#/home' || hash.startsWith('#/home?');
}

function delay(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function matchesSourceName(item, targetName) {
    return normalizeName(item?.Name) === targetName
        || normalizeName(item?.SortName) === targetName;
}

async function findAutoplaySourceByName(apiClient, sourceName) {
    const api = toApi(apiClient);
    const userId = apiClient.getCurrentUserId();
    const targetName = normalizeName(sourceName);

    const { data: playlistData } = await getItemsApi(api).getItems({
        userId,
        includeItemTypes: [BaseItemKind.Playlist],
        recursive: true,
        searchTerm: sourceName,
        enableUserData: false,
        limit: 200
    });

    const playlist = (playlistData.Items || []).find(item => matchesSourceName(item, targetName));

    if (playlist) {
        return playlist;
    }

    const { data: viewsData } = await getUserViewsApi(api).getUserViews({ userId });
    return (viewsData.Items || []).find(item => matchesSourceName(item, targetName));
}

function isNavigatedToSource(sourceId) {
    const hash = window.location.hash || '';
    return hash.includes(sourceId)
        || hash.includes(`parentId=${sourceId}`)
        || hash.includes(`topParentId=${sourceId}`);
}

async function waitForLibraryPage(sourceId, maxAttempts = 100) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const onLibraryPage = document.querySelector(
            '.libraryPage:not(.homePage), #musicPage, #musicRecommendedPage, #moviesPage, #homevideos, #listPage'
        );

        if (onLibraryPage && isNavigatedToSource(sourceId)) {
            return true;
        }

        await delay(100);
    }

    return false;
}

async function startLibraryPlayback(apiClient, source) {
    const userId = apiClient.getCurrentUserId();
    const item = await apiClient.getItem(userId, source.Id);

    await playbackManager.play({
        items: [item]
    });
}

async function openLibraryAndPlay(apiClient, source) {
    const url = appRouter.getRouteUrl(source);

    console.info('[HomePlaylistAutoplay] Navigating to', url);

    await appRouter.show(url);

    const navigated = await waitForLibraryPage(source.Id);

    if (!navigated) {
        console.warn('[HomePlaylistAutoplay] Library page not detected, starting playback anyway');
    }

    await delay(750);

    await startLibraryPlayback(apiClient, source);
}

/**
 * Opens the configured library/playlist and starts play-all style playback.
 */
export async function tryHomePlaylistAutoplay(apiClient, user) {
    if (autoplaySequenceActive) {
        return;
    }

    const client = apiClient || ServerConnections.currentApiClient();

    if (!client) {
        console.warn('[HomePlaylistAutoplay] No ApiClient available');
        return;
    }

    let currentUser = user;

    if (!currentUser) {
        try {
            currentUser = await client.getCurrentUser();
        } catch (err) {
            console.warn('[HomePlaylistAutoplay] Failed to resolve current user', err);
            return;
        }
    }

    if (!isTargetUser(currentUser)) {
        return;
    }

    autoplaySequenceActive = true;

    try {
        const source = await findAutoplaySourceByName(client, AUTOPLAY_PLAYLIST_NAME);

        if (!source) {
            console.warn(
                `[HomePlaylistAutoplay] Playlist or library "${AUTOPLAY_PLAYLIST_NAME}" not found for user "${AUTOPLAY_USERNAME}"`
            );
            return;
        }

        console.info(
            `[HomePlaylistAutoplay] Opening "${AUTOPLAY_PLAYLIST_NAME}" (${source.Type}, ${source.CollectionType || 'no collection type'}) for user "${currentUser.Name}"`
        );

        toast(AUTOPLAY_TOAST_MESSAGE);
        await openLibraryAndPlay(client, source);

        console.info('[HomePlaylistAutoplay] Playback started from library page');
    } catch (err) {
        console.error('[HomePlaylistAutoplay] Failed to start library playback', err);
    } finally {
        autoplaySequenceActive = false;
    }
}

function scheduleHomeAutoplay() {
    window.setTimeout(() => {
        if (!isOnHomeRoute() || autoplaySequenceActive) {
            return;
        }

        void tryHomePlaylistAutoplay();
    }, 250);
}

function onHomePageShow(event) {
    if (!isHomePageElement(event.target) || autoplaySequenceActive) {
        return;
    }

    scheduleHomeAutoplay();
}

document.addEventListener('viewshow', onHomePageShow, true);
document.addEventListener('pageshow', onHomePageShow, true);

Events.on(ServerConnections, 'localusersignedin', () => {
    scheduleHomeAutoplay();
});
