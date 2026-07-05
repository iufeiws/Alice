import type { GoogleStreetViewLocation } from "../../../channels/google-streetview/src/index.js";

export function moveLocation(location: GoogleStreetViewLocation, headingDegrees: number, distanceMeters: number): GoogleStreetViewLocation {
  const earthRadiusMeters = 6_371_000;
  const angularDistance = distanceMeters / earthRadiusMeters;
  const bearing = degreesToRadians(headingDegrees);
  const lat1 = degreesToRadians(location.lat);
  const lng1 = degreesToRadians(location.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    lat: radiansToDegrees(lat2),
    lng: normalizeLongitude(radiansToDegrees(lng2))
  };
}

export function distanceMeters(a: GoogleStreetViewLocation, b: GoogleStreetViewLocation): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLat = degreesToRadians(b.lat - a.lat);
  const deltaLng = degreesToRadians(b.lng - a.lng);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function validLocation(location: GoogleStreetViewLocation): boolean {
  return Number.isFinite(location.lat) && Number.isFinite(location.lng)
    && location.lat >= -90 && location.lat <= 90
    && location.lng >= -180 && location.lng <= 180;
}

export function headingDelta(a: number, b: number): number {
  const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(delta, 360 - delta);
}

export function bearingDegrees(a: GoogleStreetViewLocation, b: GoogleStreetViewLocation): number {
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const deltaLng = degreesToRadians(b.lng - a.lng);
  return normalizeHeading(radiansToDegrees(Math.atan2(
    Math.sin(deltaLng) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
  )));
}

export function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function normalizeLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
