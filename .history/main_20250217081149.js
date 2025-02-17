/**********************************************
 * GLOBAL VARIABLES & INITIAL SETTINGS
 **********************************************/
// Google Maps and autocomplete objects
let map;
let autoCompleteStart;
let autoCompleteEnd;
let autoCompleteSingle;
let directionsService = null;
let directionsRenderer = null;
let directionsServiceReady = false;
let isMapReady = false;

// Arrays for markers and route info
let gasStationMarkers = [];
let routeMarkers = [];
let stationsAlongCurrentRoute = [];
let activeHighlightedStations = [];

// Current route start/end addresses
let currentRouteStart = "";
let currentRouteEnd = "";

// Reference location used for filtering (e.g., single address or route start)
let currentReferenceLocation = null;

// InfoWindow to display marker info on the map
let infoWindow;

// Global min/max price (used to build price filter options)
let globalMinPrice = Infinity;
let globalMaxPrice = -Infinity;

// Google Sheets Info for fetching data (still in use for Casey)
const spreadsheetId = "1wBdV3SB94eB5U49OWn2BQNGFQ8x8_O9SzUslIdqZ_2o";
const apiKey = "AIzaSyD...";

/**********************************************
 * HELPER FUNCTIONS
 **********************************************/

/**
 * Fetch the last-updated timestamp from Google Sheets developer metadata.
 */
async function fetchLastUpdatedTime() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=developerMetadata&key=${apiKey}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.developerMetadata) {
      const lastModifiedMetadata = data.developerMetadata.find(
        (meta) => meta.metadataKey === "lastModified"
      );
      if (lastModifiedMetadata && lastModifiedMetadata.metadataValue) {
        return new Date(lastModifiedMetadata.metadataValue);
      }
    }
    console.warn("No lastModified metadata found in the response.");
    return null;
  } catch (error) {
    console.error("Error fetching last updated time:", error);
    return null;
  }
}

/**
 * Display the last-updated timestamp in the page footer.
 */
async function displayLastUpdatedTime() {
  const footerElement = document.getElementById("last-updated");
  const lastUpdatedTime = await fetchLastUpdatedTime();
  if (lastUpdatedTime) {
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      timeZoneName: "short",
    };
    const formattedTime = lastUpdatedTime.toLocaleString("en-US", options);
    footerElement.textContent = `Prices last updated: ${formattedTime}`;
  } else {
    footerElement.textContent = "Failed to fetch the last updated time.";
  }
}

/**
 * Fetches Casey station data from Google Sheets (CSV format).
 * Updates globalMinPrice and globalMaxPrice based on station prices.
 *
 * IMPORTANT: confirm the CSV columns match your actual sheet!
 * If your sheet columns are named "Today's Price" with a space,
 * then we do row["Today's Price"] instead of row["Today'sPrice"].
 */
async function fetchLocations() {
  // Only Casey CSV URL
  const caseyCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=1692662712&single=true&output=csv";

  console.log("Attempting to fetch Casey CSV data from:", caseyCSVUrl);

  try {
    const caseyResponse = await fetch(caseyCSVUrl);
    console.log("Casey response status:", caseyResponse.status, caseyResponse.statusText);

    if (!caseyResponse.ok) {
      throw new Error("Error loading Casey data");
    }

    const caseyCsvText = await caseyResponse.text();
    console.log("Casey CSV text length:", caseyCsvText.length);

    // Parse the CSV using PapaParse
    const caseyParsed = Papa.parse(caseyCsvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });
    console.log("PapaParse errors:", caseyParsed.errors);
    const caseyData = caseyParsed.data;

    console.log("Parsed Casey data row count:", caseyData.length);
    if (caseyData.length > 0) {
      console.log("Sample row:", caseyData[0]);
    }

    // Build an array of station objects for Casey
    // ---- Replace with EXACT column names that match your CSV ----
    const caseyLocations = caseyData
      .map((row) => {
        // Example: if your CSV column is "Today's Price" with a space:
        const rawPrice = row["Today'sPrice"] || row["Today's Price"]; 
        // If your actual CSV says "Today'sPrice", keep it that way.

        let price = parseFloat(rawPrice?.replace("$", ""));
        if (!isNaN(price)) {
          globalMinPrice = Math.min(globalMinPrice, price);
          globalMaxPrice = Math.max(globalMaxPrice, price);
        }

        // Also handle Tomorrow's Price if needed:
        const rawTomorrow = row["Tomorrow'sPrice"] || row["Tomorrow's Price"];
        const tomorrowPrice = parseFloat(rawTomorrow?.replace("$", ""));

        const lat = parseFloat(row["Latitude"]);
        const lng = parseFloat(row["Longitude"]);

        // Log each row if you want more debugging:
        // console.log("Row debug:", { lat, lng, price, tomorrowPrice, city: row["City"], state: row["State"] });

        // Return an object if lat/lng are valid
        if (!isNaN(lat) && !isNaN(lng)) {
          return {
            locationNumberC: String(row["Location #"]),
            latC: lat,
            lngC: lng,
            cityC: row["City"],
            stateC: row["State"],
            todaysPriceC: price,
            tomorrowPriceC: tomorrowPrice,
            stationType: "Casey",
          };
        } else {
          // If lat/lng is invalid, return null to filter out
          return null;
        }
      })
      .filter(Boolean); // remove any null entries

    console.log("Final station count after lat/lng filter:", caseyLocations.length);

    return caseyLocations;
  } catch (error) {
    console.error("Error fetching locations:", error);
    return [];
  }
}

/**
 * Removes markers from the map and clears the given array.
 */
function clearMarkers(markerArray) {
  markerArray.forEach((marker) => marker.setMap(null));
  markerArray.length = 0;
}

/**********************************************
 * FILTERING FUNCTIONS
 **********************************************/

/**
 * Given an array of station markers and an optional reference location,
 * returns only those stations that pass the station-type, price, and distance filters.
 */
function filterStations(stations, userLocation) {
  if (!stations || stations.length === 0) {
    console.warn("⚠️ No stations to filter.");
    return [];
  }

  // Station type filter
  const selectedType = document.getElementById("station-filter").value.toLowerCase();
  console.log(`🔍 Selected Station Type: ${selectedType}`);

  // Price filter
  const selectedPrice = document.getElementById("price-filter").value;
  let priceFilterActive = false;
  let priceMin = 0,
    priceMax = Infinity;
  if (selectedPrice && selectedPrice !== "all-prices") {
    const parts = selectedPrice.split("-");
    if (parts.length === 2) {
      priceMin = parseFloat(parts[0]);
      priceMax = parseFloat(parts[1]);
      priceFilterActive = true;
    }
  }
  console.log(`💲 Price Filter Active: ${priceFilterActive}, Min: ${priceMin}, Max: ${priceMax}`);

  // Distance filter
  let maxDistance = Infinity;
  if (userLocation) {
    const selectedDistance = document.getElementById("distance-filter").value;
    // "Any Distance" or "40+ Miles" means effectively no distance limit.
    if (selectedDistance === "0" || selectedDistance === "5") {
      maxDistance = Infinity;
    } else {
      const milesToMeters = (miles) => miles * 1609.34;
      switch (selectedDistance) {
        case "1":
          maxDistance = milesToMeters(10);
          break;
        case "2":
          maxDistance = milesToMeters(20);
          break;
        case "3":
          maxDistance = milesToMeters(30);
          break;
        case "4":
          maxDistance = milesToMeters(40);
          break;
        default:
          maxDistance = Infinity;
      }
    }
    console.log(`📏 Max Distance (meters): ${maxDistance}`);
  } else {
    console.log("📏 No reference location provided – skipping distance filtering.");
  }

  // Final filter step
  return stations.filter((marker) => {
    // stationType check
    const matchesType =
      selectedType === "all" || marker.stationType.toLowerCase() === selectedType;

    // station price
    const haulerPrice = marker.todaysPriceC;
    const matchesPrice =
      !priceFilterActive ||
      (haulerPrice >= priceMin && haulerPrice < priceMax);

    // distance check
    let matchesDistance = true;
    if (userLocation) {
      const stationPosition = marker.getPosition();
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        userLocation,
        stationPosition
      );
      matchesDistance = distance <= maxDistance;
    }

    return matchesType && matchesPrice && matchesDistance;
  });
}

/**
 * Applies filters either to the activeHighlightedStations or all markers.
 */
function applyFilters() {
  if (!map) return;
  console.log("🔄 Reapplying filters...");

  const markersToFilter =
    activeHighlightedStations && activeHighlightedStations.length > 0
      ? activeHighlightedStations
      : gasStationMarkers;

  // Hide them
  markersToFilter.forEach((marker) => marker.setVisible(false));

  // Filter
  const userLocation = currentReferenceLocation;
  const filteredStations = filterStations(markersToFilter, userLocation);

  // Show only the filtered results
  filteredStations.forEach((marker) => marker.setVisible(true));

  console.log(`✅ Filtered stations: ${filteredStations.length}`);
}

/**
 * Dynamically build price range filter options based on globalMinPrice/globalMaxPrice.
 */
function updatePriceFilterOptions(stations) {
  const priceFilter = document.getElementById("price-filter");

  // Clear existing <option>s
  priceFilter.innerHTML = "";

  // "All Prices" option
  const optionAll = document.createElement("option");
  optionAll.value = "all-prices";
  optionAll.textContent = "All Prices";
  priceFilter.appendChild(optionAll);

  // Ensure numeric defaults
  let min = Math.floor(globalMinPrice * 4) / 4; 
  let max = Math.ceil(globalMaxPrice * 4) / 4;  

  // Build 0.25 increments
  for (let price = min; price < max; price += 0.25) {
    let count = stations.filter((marker) => {
      let markerPrice = marker.todaysPriceC;
      return markerPrice >= price && markerPrice < price + 0.25;
    }).length;

    const option = document.createElement("option");
    option.value = `${price.toFixed(2)}-${(price + 0.25).toFixed(2)}`;
    option.textContent = `$${price.toFixed(2)} - $${(price + 0.25).toFixed(2)} (${count})`;
    priceFilter.appendChild(option);
  }
}

/**********************************************
 * MAP INITIALIZATION & MARKER FUNCTIONS
 **********************************************/

/**
 * Builds the main map
 */
function buildMap() {
  console.log("Building map...");
  const mapContainer = document.getElementById("map");
  if (!mapContainer) {
    console.error("Map container not found!");
    return;
  }

  const mapOptions = {
    center: { lat: 39.8283, lng: -98.5795 },
    zoom: 4.5,
  };
  const newMap = new google.maps.Map(mapContainer, mapOptions);

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
  directionsRenderer.setMap(newMap);

  newMap.addListener("zoom_changed", resizeMarkersBasedOnZoom);

  return newMap;
}

/**
 * Autocomplete setup
 */
function setupAutocomplete() {
  console.log("Setting up autocomplete...");

  autoCompleteStart = new google.maps.places.Autocomplete(document.getElementById("start"));
  autoCompleteStart.addListener("place_changed", onPlaceChangedStart);

  autoCompleteEnd = new google.maps.places.Autocomplete(document.getElementById("end"));
  autoCompleteEnd.addListener("place_changed", onPlaceChangedEnd);

  autoCompleteSingle = new google.maps.places.Autocomplete(document.getElementById("singleAddressInput"), {
    types: ["geocode"],
    componentRestrictions: { country: "us" },
  });
  autoCompleteSingle.addListener("place_changed", () => {
    const place = autoCompleteSingle.getPlace();
    if (!place.geometry || !place.geometry.location) {
      alert("No details available for the selected address. Please try again.");
      return;
    }
    console.log("📍 Selected Address:", place.formatted_address);
  });
}

/**
 * Called by Google Maps script to initialize everything.
 */
window.initMap = async function initMap() {
  console.log("initMap called!");

  map = buildMap();
  if (!map) {
    console.error("Map failed to build.");
    return;
  }

  setupAutocomplete();
  directionsServiceReady = true;
  isMapReady = true;

  setupFilterListeners();

  // Fetch stations
  const locations = await fetchLocations();
  console.log(`Fetched ${locations.length} station objects from CSV.`);

  // Safety check
  if (globalMinPrice === Infinity) globalMinPrice = 0;
  if (globalMaxPrice === -Infinity) globalMaxPrice = 100;

  // Plot
  plotLocationsOnMap(map, locations);

  // Build price filter dropdown
  updatePriceFilterOptions(gasStationMarkers);

  // Trigger a map resize after a short delay
  setTimeout(() => google.maps.event.trigger(map, "resize"), 100);

  console.log("✅ Google Maps initialized successfully.");
};

/**
 * Plot Casey stations on the map
 */
function plotLocationsOnMap(map, locations) {
  clearMarkers(gasStationMarkers);
  infoWindow = new google.maps.InfoWindow();
  let markerId = 0;

  locations.forEach((location) => {
    if (location.latC && location.lngC) {
      const stationMarker = new google.maps.Marker({
        position: { lat: location.latC, lng: location.lngC },
        map: map,
        title: `${location.cityC}, ${location.stateC}`,
        icon: {
          url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new google.maps.Size(16, 16),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        },
      });

      stationMarker.stationType = "Casey";
      stationMarker.todaysPriceC = location.todaysPriceC;
      stationMarker.cityC = location.cityC;
      stationMarker.stateC = location.stateC;
      stationMarker.originalIcon = stationMarker.getIcon();
      stationMarker.isWaypoint = false;
      stationMarker.id = "marker-" + markerId++;

      // Marker click => InfoWindow
      stationMarker.addListener("click", () => {
        const contentHTML = `
          <div>
            <strong>Casey Station</strong><br>
            <b>City:</b> ${location.cityC}, ${location.stateC}<br>
            <b>Hauler's Price:</b> $${(location.todaysPriceC || 0).toFixed(2)}<br>
          </div>`;
        infoWindow.setContent(contentHTML);
        infoWindow.open(map, stationMarker);

        clearHighlights();
        highlightListItem(stationMarker.id);

        // If in route mode, show "Mark as waypoint" prompt
        if (document.getElementById("modeSelect").value === "route") {
          const card = document.querySelector(`.station-card[data-marker-id="${stationMarker.id}"]`);
          if (card) {
            showCardWaypointPrompt(card, stationMarker);
          }
        }
      });

      gasStationMarkers.push(stationMarker);
    }
  });
}

/**
 * Resize marker icons on zoom
 */
function resizeMarkersBasedOnZoom() {
  const zoomLevel = map.getZoom();
  const defaultZoom = 4.5;
  const defaultSize = 16;
  let markerSize;

  if (zoomLevel > defaultZoom) {
    markerSize = defaultSize + (zoomLevel - defaultZoom) * 4;
  } else {
    markerSize = Math.max(10, defaultSize - (defaultZoom - zoomLevel) * 1.5);
  }

  gasStationMarkers.forEach((marker) => {
    const icon = marker.getIcon();
    if (icon) {
      const anchorX = Math.floor(markerSize / 2);
      const anchorY = markerSize;
      marker.setIcon({
        ...icon,
        scaledSize: new google.maps.Size(markerSize, markerSize),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(anchorX, anchorY),
      });
    }
  });
}

/**********************************************
 * AUTOCOMPLETE EVENT HANDLERS
 **********************************************/

function onPlaceChangedStart() {
  const place = autoCompleteStart.getPlace();
  if (place.geometry) {
    map.setCenter(place.geometry.location);
    map.setZoom(15);
    const marker = new google.maps.Marker({
      map: map,
      position: place.geometry.location,
      title: place.name,
    });
    routeMarkers.push(marker);
  }
}

function onPlaceChangedEnd() {
  const place = autoCompleteEnd.getPlace();
  if (place.geometry) {
    map.setCenter(place.geometry.location);
    map.setZoom(15);
    const marker = new google.maps.Marker({
      map: map,
      position: place.geometry.location,
      title: place.name,
    });
    routeMarkers.push(marker);
  }
}

/**********************************************
 * SINGLE-ADDRESS MODE FUNCTIONS
 **********************************************/
async function findStationsForSingleAddress() {
  const address = document.getElementById("singleAddressInput").value.trim();
  if (!address) {
    alert("Please enter an address.");
    return;
  }

  try {
    const geocoder = new google.maps.Geocoder();
    const center = await new Promise((resolve, reject) => {
      geocoder.geocode({ address }, (results, status) => {
        if (status === "OK") {
          resolve(results[0].geometry.location);
        } else {
          reject("Geocoding failed: " + status);
        }
      });
    });

    console.log("📍 Geocoded Center:", center);
    currentReferenceLocation = center;

    gasStationMarkers.forEach((marker) => marker.setVisible(false));
    gasStationMarkers.forEach((marker) => {
      const distance = google.maps.geometry.spherical.computeDistanceBetween(center, marker.getPosition());
      marker.distance = distance;
    });

    // 50-mile radius (80,467 meters)
    const radiusInMeters = 80467;
    let stationsInRange = gasStationMarkers.filter((marker) => marker.distance <= radiusInMeters);

    // Apply station filters
    stationsInRange = filterStations(stationsInRange, center);

    activeHighlightedStations = stationsInRange;

    stationsInRange.forEach((marker) => {
      marker.setIcon({
        url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
        scaledSize: new google.maps.Size(22, 22),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(11, 22),
      });
      marker.setVisible(true);
    });

    console.log(`🔍 Stations after filtering: ${stationsInRange.length}`);

    const highlightedStationsContainer = document.getElementById("highlightedStationsContainer");
    const highlightedStationsList = document.getElementById("highlightedStationsList");
    highlightedStationsList.innerHTML = "";

    if (stationsInRange.length > 0) {
      stationsInRange.forEach((marker) => {
        const li = document.createElement("li");
        li.className = "station-card";
        li.setAttribute("data-marker-id", marker.id);

        let stationLabel = "Casey Station";
        let city = marker.cityC;
        let state = marker.stateC;
        let todaysPrice = marker.todaysPriceC;
        if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);

        li.innerHTML = `
          <h4>${stationLabel}</h4>
          <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
          <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
        `;

        li.addEventListener("click", () => {
          if (document.getElementById("modeSelect").value === "route") {
            google.maps.event.trigger(marker, "click");
            showCardWaypointPrompt(li, marker);
          } else {
            google.maps.event.trigger(marker, "click");
          }
          clearHighlights();
          li.classList.add("highlight");
        });

        highlightedStationsList.appendChild(li);
      });

      highlightedStationsContainer.style.display = "block";
    } else {
      highlightedStationsContainer.style.display = "none";
      alert("No stations found near the entered address.");
    }

    map.setCenter(center);
    map.setZoom(8);
  } catch (error) {
    console.error(error);
    alert("Could not find gas stations for the entered address.");
  }
}

/**********************************************
 * ROUTE MODE FUNCTIONS
 **********************************************/
async function performRoute() {
  if (!isMapReady || !directionsService || !directionsRenderer) {
    console.error("Map or directions services are not ready.");
    return;
  }

  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();
  if (!start && !end) {
    alert("Please enter at least one address.");
    return;
  }

  currentRouteStart = start || end;
  currentRouteEnd = end || start;

  const routeRequest = {
    origin: start || end,
    destination: end || start,
    travelMode: google.maps.TravelMode.DRIVING,
  };

  if (!start || !end) {
    routeRequest.destination = routeRequest.origin;
    alert("Only one address provided. Creating a route that loops back to the same location.");
  }

  try {
    const result = await new Promise((resolve, reject) => {
      directionsService.route(routeRequest, (response, status) => {
        if (status === google.maps.DirectionsStatus.OK) {
          resolve(response);
        } else {
          reject(status);
        }
      });
    });

    directionsRenderer.setDirections(result);

    if (result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0]) {
      currentReferenceLocation = result.routes[0].legs[0].start_location;
    }

    const routePolyline = result.routes[0].overview_path;
    await highlightStationsAlongRoute(routePolyline);

    document.getElementById("openGoogleMapsRoute").style.display = "block";
    document.getElementById("highlightedStationsContainer").style.display = "block";
  } catch (error) {
    console.error("Error calculating route:", error);
    alert("Route calculation failed: " + error);
  }
}

async function highlightStationsAlongRoute(routePolyline) {
  const highlightedStationsContainer = document.getElementById("highlightedStationsList");
  const highlightedStationsParent = document.getElementById("highlightedStationsContainer");

  highlightedStationsContainer.innerHTML = "";
  gasStationMarkers.forEach((marker) => marker.setVisible(false));

  let stationsNearRoute = [];
  gasStationMarkers.forEach((marker) => {
    const markerPosition = marker.getPosition();
    let isNearRoute = false;
    let minDistance = Infinity;

    // ~5 km threshold from the route
    for (let i = 0; i < routePolyline.length - 1; i++) {
      const segmentStart = routePolyline[i];
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        markerPosition,
        segmentStart
      );
      if (distance <= 5000) {
        isNearRoute = true;
        minDistance = Math.min(minDistance, distance);
        break;
      }
    }

    if (isNearRoute) {
      marker.distance = minDistance;
      stationsNearRoute.push(marker);
    }
  });

  console.log(`🚀 Stations before filtering: ${stationsNearRoute.length}`);

  stationsNearRoute = filterStations(stationsNearRoute, currentReferenceLocation);
  console.log(`🔍 Stations after filtering: ${stationsNearRoute.length}`);

  stationsAlongCurrentRoute = stationsNearRoute;
  activeHighlightedStations = stationsNearRoute;

  stationsNearRoute.forEach((marker) => {
    if (!marker.isWaypoint) {
      marker.setIcon({
        url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
        scaledSize: new google.maps.Size(22, 22),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(11, 22),
      });
    }
    marker.setVisible(true);
  });

  if (stationsNearRoute.length > 0) {
    stationsNearRoute.forEach((marker) => {
      if (!marker.isWaypoint) {
        marker.setIcon({
          url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
          scaledSize: new google.maps.Size(22, 22),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(11, 22),
        });
      }
      marker.setVisible(true);

      const li = document.createElement("li");
      li.className = "station-card";
      li.setAttribute("data-marker-id", marker.id);

      let stationLabel = "Casey Station";
      let city = marker.cityC;
      let state = marker.stateC;
      let todaysPrice = marker.todaysPriceC;
      if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);

      li.innerHTML = `
        <h4>${stationLabel}</h4>
        <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
        <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
      `;

      li.addEventListener("click", () => {
        if (document.getElementById("modeSelect").value === "route") {
          google.maps.event.trigger(marker, "click");
          showCardWaypointPrompt(li, marker);
        } else {
          google.maps.event.trigger(marker, "click");
        }
        clearHighlights();
        li.classList.add("highlight");
      });

      highlightedStationsContainer.appendChild(li);
    });

    highlightedStationsParent.style.display = "block";
  } else {
    highlightedStationsParent.style.display = "none";
  }
}

/**********************************************
 * "OPEN IN GOOGLE MAPS" FUNCTION
 **********************************************/
function buildGoogleMapsLink(origin, destination, waypointsArray) {
  const baseUrl = "https://www.google.com/maps/dir/?api=1";
  const originParam = `origin=${encodeURIComponent(origin)}`;
  const destinationParam = `destination=${encodeURIComponent(destination)}`;
  const travelModeParam = `travelmode=driving`;

  let waypointsParam = "";
  if (waypointsArray.length > 0) {
    const joined = waypointsArray.join("|");
    waypointsParam = `&waypoints=${encodeURIComponent(joined)}`;
  }

  return `${baseUrl}&${originParam}&${destinationParam}&${travelModeParam}${waypointsParam}`;
}

function openGoogleMapsRoute() {
  console.log("openGoogleMapsRoute() called.");
  console.log("currentRouteStart:", currentRouteStart, "currentRouteEnd:", currentRouteEnd);

  if (!currentRouteStart || !currentRouteEnd) {
    alert("No valid route to open. Please create a route first.");
    return;
  }

  let selectedMarkers = gasStationMarkers.filter((m) => m.isWaypoint);
  console.log("Number of markers flagged as waypoints:", selectedMarkers.length);

  if (selectedMarkers.length === 0 && stationsAlongCurrentRoute.length > 0) {
    selectedMarkers = stationsAlongCurrentRoute;
    console.log("Using stationsAlongCurrentRoute. Count:", selectedMarkers.length);
  }

  if (selectedMarkers.length === 0) {
    alert("No stations found to include as waypoints.");
    return;
  }

  const waypointCoords = selectedMarkers.map((marker) => {
    const pos = marker.getPosition();
    return `${pos.lat()},${pos.lng()}`;
  });

  console.log("Waypoint coordinates:", waypointCoords);

  const googleMapsUrl = buildGoogleMapsLink(currentRouteStart, currentRouteEnd, waypointCoords);
  console.log("Generated Google Maps URL:", googleMapsUrl);
  window.open(googleMapsUrl, "_blank");
}

/**********************************************
 * MISC / STATE MANAGEMENT
 **********************************************/
function refreshTool() {
  console.log("Refreshing tool state...");

  document.getElementById("singleAddressInput").value = "";
  document.getElementById("start").value = "";
  document.getElementById("end").value = "";

  const stationFilter = document.getElementById("station-filter");
  if (stationFilter) stationFilter.value = "all";

  const priceFilter = document.getElementById("price-filter");
  if (priceFilter) priceFilter.value = "all-prices";

  const distanceFilter = document.getElementById("distance-filter");
  if (distanceFilter) distanceFilter.value = "0";

  const filterSection = document.getElementById("filter-section");
  if (filterSection && !filterSection.classList.contains("hidden")) {
    filterSection.classList.add("hidden");
  }
  const toggleFiltersBtn = document.getElementById("toggleFilters");
  if (toggleFiltersBtn) {
    toggleFiltersBtn.classList.remove("active");
  }

  const highlightedStationsList = document.getElementById("highlightedStationsList");
  if (highlightedStationsList) highlightedStationsList.innerHTML = "";

  const highlightedStationsContainer = document.getElementById("highlightedStationsContainer");
  if (highlightedStationsContainer) highlightedStationsContainer.style.display = "none";

  gasStationMarkers.forEach((marker) => {
    marker.isWaypoint = false;
    marker.setIcon(marker.originalIcon);
    marker.setVisible(true);
  });

  if (directionsRenderer) {
    directionsRenderer.setDirections({ routes: [] });
  }

  routeMarkers.forEach((marker) => marker.setMap(null));
  routeMarkers = [];

  const googleMapsLinkDiv = document.getElementById("openGoogleMapsRoute");
  if (googleMapsLinkDiv) googleMapsLinkDiv.style.display = "none";

  currentRouteStart = "";
  currentRouteEnd = "";
  stationsAlongCurrentRoute = [];
  currentReferenceLocation = null;
  clearHighlights();
  activeHighlightedStations = [];

  if (infoWindow) infoWindow.close();

  const mode = document.getElementById("modeSelect").value;
  if (mode === "single") {
    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 });
      map.setZoom(4.5);
    }
    document.getElementById("singleAddressTool").style.display = "block";
    document.getElementById("routeTool").style.display = "none";
    applyFilters();
  } else if (mode === "route") {
    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 });
      map.setZoom(4.5);
    }
    document.getElementById("singleAddressTool").style.display = "none";
    document.getElementById("routeTool").style.display = "block";
  }

  console.log("Tool state refreshed.");
}

function setupFilterListeners() {
  const stationFilter = document.getElementById("station-filter");
  const priceFilter = document.getElementById("price-filter");
  const distanceFilter = document.getElementById("distance-filter");
  const modeSelect = document.getElementById("modeSelect");

  if (stationFilter) stationFilter.addEventListener("change", applyFilters);
  if (priceFilter) priceFilter.addEventListener("change", applyFilters);
  if (distanceFilter) {
    distanceFilter.addEventListener("change", () => {
      if (modeSelect.value === "single") {
        applyFilters();
      } else if (modeSelect.value === "route") {
        if (currentReferenceLocation) {
          applyFilters();
        } else {
          console.log("Route not created yet; ignoring distance filter changes.");
        }
      }
    });
  }
}

/**********************************************
 * DOCUMENT-READY-LIKE EVENT
 **********************************************/
document.addEventListener("DOMContentLoaded", () => {
  const modeSelect = document.getElementById("modeSelect");
  const singleAddressTool = document.getElementById("singleAddressTool");
  const routeTool = document.getElementById("routeTool");
  const tabSingle = document.getElementById("tabSingle");
  const tabRoute = document.getElementById("tabRoute");

  function updateToolMode() {
    refreshTool();
    const filterSection = document.getElementById("filter-section");
    if (filterSection) filterSection.classList.add("hidden");
    const toggleFiltersBtn = document.getElementById("toggleFilters");
    if (toggleFiltersBtn) toggleFiltersBtn.classList.remove("active");

    const mode = modeSelect.value;
    const distanceFilter = document.getElementById("distance-filter");

    if (mode === "route") {
      if (distanceFilter) distanceFilter.disabled = true;
      singleAddressTool.style.display = "none";
      routeTool.style.display = "block";
    } else {
      if (distanceFilter) distanceFilter.disabled = false;
      singleAddressTool.style.display = "block";
      routeTool.style.display = "none";
      document.getElementById("map-container").style.display = "block";
      if (!map) {
        console.log("No map detected in single mode—calling initMap()");
        initMap();
      }
    }

    document.getElementById("highlightedStationsList").innerHTML = "";
    document.getElementById("highlightedStationsContainer").style.display = "none";

    gasStationMarkers.forEach((marker) => {
      marker.setIcon(marker.originalIcon);
      marker.setVisible(true);
    });

    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 });
      map.setZoom(4.5);
      if (directionsRenderer) {
        directionsRenderer.setDirections({ routes: [] });
      }
      routeMarkers.forEach((marker) => marker.setMap(null));
      routeMarkers = [];
    }

    // Show/hide the correct action buttons
    document.getElementById("findStations").style.display = mode === "single" ? "inline-block" : "none";
    document.getElementById("calculateRoute").style.display = mode === "route" ? "inline-block" : "none";
  }

  modeSelect.value = "single";
  updateToolMode();

  tabSingle.addEventListener("click", () => {
    modeSelect.value = "single";
    updateToolMode();
    tabSingle.classList.add("active");
    tabRoute.classList.remove("active");
  });

  tabRoute.addEventListener("click", () => {
    modeSelect.value = "route";
    updateToolMode();
    tabRoute.classList.add("active");
    tabSingle.classList.remove("active");
  });

  const toggleFiltersButton = document.getElementById("toggleFilters");
  if (toggleFiltersButton) {
    toggleFiltersButton.addEventListener("click", () => {
      const filterSection = document.getElementById("filter-section");
      filterSection.classList.toggle("hidden");
      toggleFiltersButton.classList.toggle("active");
    });
  }

  const refreshBtn = document.getElementById("refreshTool");
  refreshBtn.addEventListener("click", refreshTool);

  // Display last updated time
  displayLastUpdatedTime();
});

/**
 * Fallback: if map isn't ready on window load, call initMap().
 */
window.addEventListener("load", () => {
  if (!isMapReady) {
    console.log("Window loaded: calling initMap as fallback.");
    initMap();
  }
});

/**
 * Prompt to mark/unmark a station as waypoint inside a station card.
 */
function showCardWaypointPrompt(card, marker) {
  document.querySelectorAll(".card-prompt").forEach((prompt) => prompt.remove());

  const promptDiv = document.createElement("div");
  promptDiv.classList.add("card-prompt");
  promptDiv.innerHTML = `
    <p>Mark station as Google Maps waypoint?</p>
    <button class="yes-btn">Yes</button>
    <button class="no-btn">No</button>
  `;
  card.appendChild(promptDiv);

  promptDiv.querySelector(".yes-btn").addEventListener("click", () => {
    updateMarkerAsWaypoint(marker);
    promptDiv.remove();
  });
  promptDiv.querySelector(".no-btn").addEventListener("click", () => {
    updateMarkerAsNotWaypoint(marker);
    promptDiv.remove();
  });
}

/**
 * Mark a station as a waypoint (changes icon).
 */
function updateMarkerAsWaypoint(marker) {
  marker.isWaypoint = true;
  marker.setIcon({
    url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
    scaledSize: new google.maps.Size(30, 30),
    origin: new google.maps.Point(0, 0),
    anchor: new google.maps.Point(15, 30),
  });
  clearHighlights();
  highlightListItem(marker.id);
}

/**
 * Mark a station as not a waypoint (changes icon).
 */
function updateMarkerAsNotWaypoint(marker) {
  marker.isWaypoint = false;
  marker.setIcon({
    url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
    scaledSize: new google.maps.Size(22, 22),
    origin: new google.maps.Point(0, 0),
    anchor: new google.maps.Point(11, 22),
  });
  clearHighlights();
  highlightListItem(marker.id);
}

/**
 * Removes highlight from all cards.
 */
function clearHighlights() {
  const stationCards = document.querySelectorAll(".station-card");
  stationCards.forEach((card) => card.classList.remove("highlight"));
}

/**
 * Highlights card for a particular marker.
 */
function highlightListItem(markerId) {
  const card = document.querySelector(`.station-card[data-marker-id="${markerId}"]`);
  if (card) {
    card.classList.add("highlight");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
