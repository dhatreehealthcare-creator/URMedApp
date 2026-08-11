"use client";

import "leaflet/dist/leaflet.css";
import { Crosshair, ExternalLink, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import { isValidGeoPoint } from "../lib/geo";

type LocationChange = { latitude: string; longitude: string; accuracy?: number };

export function GeoLocationPicker({
  latitude,
  longitude,
  onChange,
  label = "Pin the exact location",
}: {
  latitude: string;
  longitude: string;
  onChange: (location: LocationChange) => void;
  label?: string;
}) {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const [locating, setLocating] = useState(false);
  const [status, setStatus] = useState("Click the map or use this device's GPS.");
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid = latitude !== "" && longitude !== "" && isValidGeoPoint(point);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !mapElement.current || map.current) return;
      const initial: [number, number] = valid ? [point.latitude, point.longitude] : [17.385, 78.4867];
      const instance = L.map(mapElement.current, { zoomControl: true }).setView(initial, valid ? 15 : 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(instance);
      const icon = L.divIcon({ className: "geo-map-marker", html: "<span></span>", iconSize: [30, 38], iconAnchor: [15, 38] });
      const selected = L.marker(initial, { draggable: true, icon }).addTo(instance);
      if (!valid) selected.setOpacity(0);
      const save = (lat: number, lon: number, message: string) => {
        selected.setLatLng([lat, lon]).setOpacity(1);
        onChangeRef.current({ latitude: lat.toFixed(6), longitude: lon.toFixed(6) });
        setStatus(message);
      };
      instance.on("click", (event) => save(event.latlng.lat, event.latlng.lng, "Map pin selected."));
      selected.on("dragend", () => {
        const position = selected.getLatLng();
        save(position.lat, position.lng, "Map pin adjusted.");
      });
      map.current = instance;
      marker.current = selected;
      window.setTimeout(() => instance.invalidateSize(), 0);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // Map is created once; coordinate updates are handled by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!valid || !map.current || !marker.current) return;
    marker.current.setLatLng([point.latitude, point.longitude]).setOpacity(1);
  }, [valid, point.latitude, point.longitude]);

  const useDeviceLocation = () => {
    if (!navigator.geolocation) { setStatus("This browser does not support device location."); return; }
    setLocating(true); setStatus("Requesting precise location permission…");
    navigator.geolocation.getCurrentPosition((position) => {
      const next = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      onChangeRef.current({ latitude: next.latitude.toFixed(6), longitude: next.longitude.toFixed(6), accuracy: position.coords.accuracy });
      map.current?.setView([next.latitude, next.longitude], 16);
      marker.current?.setLatLng([next.latitude, next.longitude]).setOpacity(1);
      setStatus(`GPS fixed within about ${Math.round(position.coords.accuracy)} metres.`);
      setLocating(false);
    }, (reason) => {
      setStatus(reason.code === reason.PERMISSION_DENIED ? "Location permission was denied. You can still click the map." : "GPS could not determine your location. Try outdoors or select the map pin.");
      setLocating(false);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  };

  const mapUrl = valid ? `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=17/${point.latitude}/${point.longitude}` : "";
  return <div className="geo-picker wide">
    <div className="geo-picker-heading"><div><MapPin size={18} /><span><strong>{label}</strong><small>{status}</small></span></div><button className="portal-outline" disabled={locating} onClick={useDeviceLocation} type="button"><Crosshair size={15} /> {locating ? "Locating…" : "Use my GPS"}</button></div>
    <div aria-label="Interactive location map" className="geo-map" ref={mapElement} />
    <div className="geo-coordinate-grid">
      <label className="portal-field"><span>Latitude *</span><input max="90" min="-90" onChange={(event) => onChange({ latitude: event.target.value, longitude })} required step="any" type="number" value={latitude} /></label>
      <label className="portal-field"><span>Longitude *</span><input max="180" min="-180" onChange={(event) => onChange({ latitude, longitude: event.target.value })} required step="any" type="number" value={longitude} /></label>
      {mapUrl && <a href={mapUrl} rel="noreferrer" target="_blank"><ExternalLink size={14} /> Open full map</a>}
    </div>
  </div>;
}
