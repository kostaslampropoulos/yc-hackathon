const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "location",
  "googleMapsUri",
  "websiteUri",
  "internationalPhoneNumber",
  "nationalPhoneNumber",
  "businessStatus",
  "primaryType",
  "primaryTypeDisplayName",
  "types",
  "regularOpeningHours",
  "currentOpeningHours",
  "utcOffsetMinutes",
  "priceLevel",
  "rating",
  "userRatingCount",
  "editorialSummary",
  "generativeSummary",
  "reviews",
  "photos",
  "reservable",
  "servesBreakfast",
  "servesLunch",
  "servesDinner",
  "takeout",
  "delivery",
  "dineIn",
].join(",");

export type PlaceDetails = {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
  websiteUri?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  businessStatus?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text: string };
  types?: string[];
  regularOpeningHours?: {
    periods?: Array<{
      open: { day: number; hour: number; minute: number };
      close?: { day: number; hour: number; minute: number };
    }>;
    weekdayDescriptions?: string[];
  };
  utcOffsetMinutes?: number;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text: string };
  generativeSummary?: { overview?: { text: string }; description?: { text: string } };
  reviews?: Array<{
    rating?: number;
    text?: { text: string };
    authorAttribution?: { displayName: string };
  }>;
  [k: string]: unknown;
};

function requireKey(): string {
  if (!API_KEY) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  return API_KEY;
}

export async function resolveMapsUrlToPlaceId(rawUrl: string): Promise<string> {
  let url = rawUrl.trim();

  // 1. Expand short links by following redirects.
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps)/.test(url)) {
    try {
      const res = await fetch(url, { redirect: "follow", next: { revalidate: 0 } });
      url = res.url;
    } catch {
      // fall through with original URL
    }
  }

  // 2. Direct place_id param.
  const directMatch = url.match(/[?&]place_id=([^&]+)/);
  if (directMatch) {
    return decodeURIComponent(directMatch[1]);
  }

  // 3. FtID pattern !1s0xHEX:0xHEX (rare in modern URLs; skip the resolver — too complex).
  //    Fall through to text search.

  // 4. Extract business name and lat/lng.
  const nameMatch = url.match(/\/maps\/place\/([^/]+)/);
  const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);

  let textQuery: string | null = null;
  if (nameMatch) {
    try {
      textQuery = decodeURIComponent(nameMatch[1].replace(/\+/g, " "));
    } catch {
      textQuery = nameMatch[1].replace(/\+/g, " ");
    }
  }

  if (!textQuery) {
    throw new Error("Could not extract business name from URL");
  }

  // 5. Places API Text Search.
  const body: Record<string, unknown> = { textQuery };
  if (coordMatch) {
    body.locationBias = {
      circle: {
        center: {
          latitude: parseFloat(coordMatch[1]),
          longitude: parseFloat(coordMatch[2]),
        },
        radius: 500,
      },
    };
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": requireKey(),
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify(body),
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Places searchText failed: ${res.status} ${txt}`);
  }

  const data = (await res.json()) as { places?: Array<{ id: string }> };
  if (!data.places || data.places.length === 0) {
    throw new Error(`No place matched textQuery "${textQuery}"`);
  }

  return data.places[0].id;
}

export async function getPlaceDetails(placeId: string): Promise<PlaceDetails> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": requireKey(),
      "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
    },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Places details failed: ${res.status} ${txt}`);
  }

  return (await res.json()) as PlaceDetails;
}
