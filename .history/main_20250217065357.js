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
const apiKey = "AIzaSyDYpNJXRFRuQq5IV8LQZi8E90r1gIaiORI";

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
 */
async function fetchLocations() {
  // Only Casey CSV URL (Pilot logic removed)
  const caseyCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=1692662712&single=true&output=csv";

  try {
    // Fetch the Casey data only
    const caseyResponse = await fetch(caseyCSVUrl);
    if (!caseyResponse.ok) throw new Error("Error loading Casey data");

    const caseyCsvText = await caseyResponse.text();

    // Parse the CSV using PapaParse
    const caseyData = Papa.parse(caseyCsvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    }).data;

    // Build an array of station objects for Casey
    const caseyLocations = caseyData.map((row) => {
      let price = parseFloat(row["Today'sPrice"]?.replace("$", ""));
      if (!isNaN(price)) {
        globalMinPrice = Math.min(globalMinPrice, price);
        globalMaxPrice = Math.max(globalMaxPrice, price);
      }
      return {
        locationNumberC: String(row["Location #"]),
        latC: parseFloat(row.Latitude),
        lngC: parseFloat(row.Longitude),
        cityC: row.City,
        stateC: row.State,
        todaysPriceC: price,
        tomorrowPriceC: parseFloat(row["Tomorrow'sPrice"]?.replace("$", "")),
        stationType: "Casey", // Keep a "stationType" property for future expansions
      };
    });

    // Return Casey stations as an array
    return caseyLocations;
  } catch (error) {
    console.error("Error fetching locations:", error);
    return [];
  }
}

/**
 * Helper function to remove markers from the map and clear the array.
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

  // 1) Station type filter
  const selectedType = document.getElementById("station-filter").value.toLowerCase();
  console.log(`🔍 Selected Station Type: ${selectedType}`);

  // 2) Price filter
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
  console.log(
    `💲 Price Filter Active: ${priceFilterActive}, Min: ${priceMin}, Max: ${priceMax}`
  );

  // 3) Distance filter
  let maxDistance = Infinity;
  if (userLocation) {
    const selectedDistance = document.getElementById("distance-filter").value;
    // "Any Distance" or "40+ Miles" means effectively no distance limit.
    if (selectedDistance === "0" || selectedDistance === "5") {
      maxDistance = Infinity;
    } else {
      // Convert miles to meters
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

  // Apply filters in a single .filter() step
  return stations.filter((marker) => {
    // Matches station type if user selected "all" or exactly the marker's type.
    const matchesType =
      selectedType === "all" || marker.stationType.toLowerCase() === selectedType;

    // Determine the station's price (for Casey)
    const haulerPrice = marker.todaysPriceC;

    // Price filter check
    const matchesPrice =
      !priceFilterActive ||
      (haulerPrice >= priceMin && haulerPrice < priceMax);

    // Distance filter check
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
 * Apply the current filters to either the globally active highlighted stations (if any)
 * or all stations on the map if none are highlighted. 
 */
function applyFilters() {
  if (!map) return;
  console.log("🔄 Reapplying filters...");

  // Decide which markers to apply the filter to
  const markersToFilter =
    activeHighlightedStations && activeHighlightedStations.length > 0
      ? activeHighlightedStations
      : gasStationMarkers;

  // Hide them all first
  markersToFilter.forEach((marker) => marker.setVisible(false));

  // Filter
  const userLocation = currentReferenceLocation;
  const filteredStations = filterStations(markersToFilter, userLocation);

  // Show only the filtered results
  filteredStations.forEach((marker) => marker.setVisible(true));

  console.log(`✅ Filtered stations: ${filteredStations.length}`);
}

/**
 * Dynamically build "price range" filter options based on globalMinPrice/globalMaxPrice
 * and how many stations fall within each price bracket.
 */
function updatePriceFilterOptions(stations) {
  const priceFilter = document.getElementById("price-filter");

  // Clear existing <option>s
  priceFilter.innerHTML = "";

  // Create an "All Prices" option
  const optionAll = document.createElement("option");
  optionAll.value = "all-prices";
  optionAll.textContent = "All Prices";
  priceFilter.appendChild(optionAll);

  // Ensure globalMinPrice / globalMaxPrice have valid numeric defaults
  let min = Math.floor(globalMinPrice * 4) / 4; // round down to nearest 0.25
  let max = Math.ceil(globalMaxPrice * 4) / 4; // round up to nearest 0.25

  // Loop from min to max in 0.25 increments
  for (let price = min; price < max; price += 0.25) {
    // Count how many stations have a price in [price, price+0.25)
    let count = stations.filter((marker) => {
      let markerPrice = marker.todaysPriceC;
      return markerPrice >= price && markerPrice < price + 0.25;
    }).length;

    // Build the <option>
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
 * Initializes and returns a Google Map instance.
 */
function buildMap() {
  console.log("Building map...");
  const mapContainer = document.getElementById("map");
  if (mapContainer) {
    mapContainer.style.height = "500px";
    mapContainer.style.width = "100%";
    mapContainer.style.backgroundColor = "#eee";
  } else {
    console.error("Map container not found!");
    return;
  }

  const mapOptions = {
    center: { lat: 39.8283, lng: -98.5795 },
    zoom: 4.5,
  };

  // Create the map
  const newMap = new google.maps.Map(mapContainer, mapOptions);

  // Create directions services
  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
  directionsRenderer.setMap(newMap);

  // Listen to zoom changes to resize markers
  newMap.addListener("zoom_changed", resizeMarkersBasedOnZoom);

  return newMap;
}

/**
 * Sets up autocomplete for single-address and route inputs.
 */
function setupAutocomplete() {
  console.log("Setting up autocomplete...");

  // Autocomplete for Start address
  autoCompleteStart = new google.maps.places.Autocomplete(
    document.getElementById("start")
  );
  autoCompleteStart.addListener("place_changed", onPlaceChangedStart);

  // Autocomplete for End address
  autoCompleteEnd = new google.maps.places.Autocomplete(
    document.getElementById("end")
  );
  autoCompleteEnd.addListener("place_changed", onPlaceChangedEnd);

  // Autocomplete for single address
  autoCompleteSingle = new google.maps.places.Autocomplete(
    document.getElementById("singleAddressInput"),
    { types: ["geocode"], componentRestrictions: { country: "us" } }
  );
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
 * Called by Google Maps script to initialize the map and fetch stations.
 */
window.initMap = async function initMap() {
  console.log("initMap called!");

  // Build and set up the main map
  map = buildMap();
  if (!map) {
    console.error("Map failed to build.");
    return;
  }

  setupAutocomplete();
  directionsServiceReady = true;
  isMapReady = true;

  // Setup event listeners for filters
  setupFilterListeners();

  // Fetch Casey station locations
  const locations = await fetchLocations();
  console.log(`Fetched ${locations.length} locations`);

  // Safety check on global min/max
  if (globalMinPrice === Infinity) globalMinPrice = 0;
  if (globalMaxPrice === -Infinity) globalMaxPrice = 100;

  // Plot the Casey stations on the map
  plotLocationsOnMap(map, locations);

  // Build the price filter dropdown
  updatePriceFilterOptions(gasStationMarkers);

  // Small hack to ensure the map properly sizes
  setTimeout(() => google.maps.event.trigger(map, "resize"), 100);

  console.log("✅ Google Maps initialized successfully.");
};

/**
 * Plots Casey locations on the map and attaches click listeners.
 */
function plotLocationsOnMap(map, locations) {
  clearMarkers(gasStationMarkers);
  infoWindow = new google.maps.InfoWindow();
  let markerId = 0;

  // For each Casey location, create a marker
  locations.forEach((location) => {
    if (location.latC && location.lngC) {
      const stationMarker = new google.maps.Marker({
        position: { lat: location.latC, lng: location.lngC },
        map: map,
        title: `${location.cityC}, ${location.stateC}`,
        // Use a blue icon for Casey (can customize as needed)
        icon: {
          url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new google.maps.Size(16, 16),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        },
      });

      // Store relevant data on the marker object
      stationMarker.stationType = "Casey";
      stationMarker.todaysPriceC = location.todaysPriceC;
      stationMarker.cityC = location.cityC;
      stationMarker.stateC = location.stateC;
      stationMarker.originalIcon = stationMarker.getIcon();
      stationMarker.isWaypoint = false;
      stationMarker.id = "marker-" + markerId++;

      // InfoWindow on marker click
      stationMarker.addListener("click", () => {
        const contentHTML = `
          <div>
            <strong>Casey Station</strong><br>
            <b>City:</b> ${location.cityC}, ${location.stateC}<br>
            <b>Hauler's Price:</b> $${location.todaysPriceC?.toFixed(2) || "N/A"}<br>
          </div>`;
        infoWindow.setContent(contentHTML);
        infoWindow.open(map, stationMarker);

        // Highlight the corresponding card in the sidebar (if displayed)
        clearHighlights();
        highlightListItem(stationMarker.id);

        // If route mode is selected, show the "Mark as Waypoint" prompt
        if (document.getElementById("modeSelect").value === "route") {
          const card = document.querySelector(
            `.station-card[data-marker-id="${stationMarker.id}"]`
          );
          if (card) {
            showCardWaypointPrompt(card, stationMarker);
          }
        }
      });

      // Add to the global array of station markers
      gasStationMarkers.push(stationMarker);
    }
  });
}

/**
 * Mark a station marker as a waypoint (sets custom icon).
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
 * Mark a station marker as not a waypoint (sets a different custom icon).
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
 * Inserts (or toggles off) a yes/no prompt inside a "Truck Stops Nearby" card
 * to allow the user to mark the station as a waypoint.
 */
function showCardWaypointPrompt(card, marker) {
  // Remove any existing waypoint prompt from any card
  document.querySelectorAll(".card-prompt").forEach((prompt) => prompt.remove());

  // Create the new prompt inside the provided card
  const promptDiv = document.createElement("div");
  promptDiv.classList.add("card-prompt");
  promptDiv.innerHTML = `
    <p>Mark station as Google Maps waypoint?</p>
    <button class="yes-btn">Yes</button>
    <button class="no-btn">No</button>
  `;
  card.appendChild(promptDiv);

  // Handle clicks on Yes/No
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
 * Removes highlight class from all station cards.
 */
function clearHighlights() {
  const stationCards = document.querySelectorAll(".station-card");
  stationCards.forEach((card) => card.classList.remove("highlight"));
}

/**
 * Highlights the station card corresponding to a given markerId.
 */
function highlightListItem(markerId) {
  const card = document.querySelector(`.station-card[data-marker-id="${markerId}"]`);
  if (card) {
    card.classList.add("highlight");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Resizes station marker icons based on the current map zoom level.
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

/**
 * Callback when the "Start" autocomplete changes; centers map on the new place.
 */
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

/**
 * Callback when the "End" autocomplete changes; centers map on the new place.
 */
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

/**
 * Finds stations near the single address the user has input,
 * filtering them by distance and price/type as configured.
 */
async function findStationsForSingleAddress() {
  const address = document.getElementById("singleAddressInput").value.trim();
  if (!address) {
    alert("Please enter an address.");
    return;
  }

  try {
    // Geocode the user's address
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

    // Hide all markers and compute distances
    gasStationMarkers.forEach((marker) => marker.setVisible(false));
    gasStationMarkers.forEach((marker) => {
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        center,
        marker.getPosition()
      );
      marker.distance = distance;
    });

    // We'll assume a 50-mile radius (80,467 meters) by default (adjust as needed)
    const radiusInMeters = 80467;
    let stationsInRange = gasStationMarkers.filter(
      (marker) => marker.distance <= radiusInMeters
    );

    // Further filter by station type/price/distance
    stationsInRange = filterStations(stationsInRange, center);

    // Record these as the actively highlighted set
    activeHighlightedStations = stationsInRange;

    // Update icons and visibility for the filtered stations
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

    // Build the sidebar list
    const highlightedStationsContainer = document.getElementById(
      "highlightedStationsContainer"
    );
    const highlightedStationsList = document.getElementById("highlightedStationsList");
    highlightedStationsList.innerHTML = "";

    if (stationsInRange.length > 0) {
      stationsInRange.forEach((marker) => {
        const li = document.createElement("li");
        li.className = "station-card";
        li.setAttribute("data-marker-id", marker.id);

        // Basic info (all we have is "Casey" now)
        let stationLabel = "Casey Station";
        let city = marker.cityC;
        let state = marker.stateC;
        let todaysPrice = marker.todaysPriceC;
        if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);

        // Construct the card
        li.innerHTML = `
          <h4>${stationLabel}</h4>
          <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
          <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
        `;

        // Highlight on click
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

    // Re-center the map on the found location
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

/**
 * Builds a route from the "Start" and "End" fields using DirectionsService,
 * displays it on the map, and highlights stations near the route.
 */
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

  // If only one address is provided, route will loop back to the same location
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
    // Request directions
    const result = await new Promise((resolve, reject) => {
      directionsService.route(routeRequest, (response, status) => {
        if (status === google.maps.DirectionsStatus.OK) {
          resolve(response);
        } else {
          reject(status);
        }
      });
    });

    // Render directions on the map
    directionsRenderer.setDirections(result);

    // Update reference location (e.g. route start) for distance filtering
    if (
      result.routes &&
      result.routes[0] &&
      result.routes[0].legs &&
      result.routes[0].legs[0]
    ) {
      currentReferenceLocation = result.routes[0].legs[0].start_location;
    }

    // Highlight stations along the route
    const routePolyline = result.routes[0].overview_path;
    await highlightStationsAlongRoute(routePolyline);

    // Show the "Open in Google Maps" link
    document.getElementById("openGoogleMapsRoute").style.display = "block";
    document.getElementById("highlightedStationsContainer").style.display = "block";
  } catch (error) {
    console.error("Error calculating route:", error);
    alert("Route calculation failed: " + error);
  }
}

/**
 * Finds and highlights stations near the given route polyline, then displays them.
 */
async function highlightStationsAlongRoute(routePolyline) {
  const highlightedStationsContainer = document.getElementById("highlightedStationsList");
  const highlightedStationsParent = document.getElementById("highlightedStationsContainer");

  highlightedStationsContainer.innerHTML = "";

  // Hide all markers initially
  gasStationMarkers.forEach((marker) => marker.setVisible(false));

  // Collect stations within a certain distance of the route
  let stationsNearRoute = [];
  gasStationMarkers.forEach((marker) => {
    const markerPosition = marker.getPosition();
    let isNearRoute = false;
    let minDistance = Infinity;

    // Check each segment to see if the marker is within ~5 km (adjust if needed)
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

  // Apply the standard station filters (type, price) + distance from route start
  stationsNearRoute = filterStations(stationsNearRoute, currentReferenceLocation);
  console.log(`🔍 Stations after filtering: ${stationsNearRoute.length}`);

  // Save them to a global for re-filtering, etc.
  stationsAlongCurrentRoute = stationsNearRoute;
  activeHighlightedStations = stationsNearRoute;

  // Update marker icon/visibility
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

  // Build the side list
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

      // Station info (Casey only)
      let stationLabel = "Casey Station";
      let city = marker.cityC;
      let state = marker.stateC;
      let todaysPrice = marker.todaysPriceC;
      if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);

      // Construct the card
      li.innerHTML = `
        <h4>${stationLabel}</h4>
        <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
        <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
      `;

      // Clicking the list item triggers the marker's click event + waypoint prompt
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

/**
 * Build a Google Maps URL to open the route with optional waypoints.
 */
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

/**
 * Opens a Google Maps window/tab with the route (start/end) plus any selected waypoints.
 */
function openGoogleMapsRoute() {
  console.log("openGoogleMapsRoute() called.");
  console.log("currentRouteStart:", currentRouteStart, "currentRouteEnd:", currentRouteEnd);

  if (!currentRouteStart || !currentRouteEnd) {
    alert("No valid route to open. Please create a route first.");
    return;
  }

  // Gather any markers flagged as waypoints
  let selectedMarkers = gasStationMarkers.filter((m) => m.isWaypoint);
  console.log("Number of markers flagged as waypoints:", selectedMarkers.length);

  // If no explicit waypoints but we do have stations along the route, use them
  if (selectedMarkers.length === 0 && stationsAlongCurrentRoute.length > 0) {
    selectedMarkers = stationsAlongCurrentRoute;
    console.log("Using stationsAlongCurrentRoute. Count:", selectedMarkers.length);
  }

  if (selectedMarkers.length === 0) {
    alert("No stations found to include as waypoints.");
    return;
  }

  // Build array of "lat,lng" strings
  const waypointCoords = selectedMarkers.map((marker) => {
    const pos = marker.getPosition();
    return `${pos.lat()},${pos.lng()}`;
  });

  console.log("Waypoint coordinates:", waypointCoords);

  // Construct the final URL and open in a new tab
  const googleMapsUrl = buildGoogleMapsLink(
    currentRouteStart,
    currentRouteEnd,
    waypointCoords
  );
  console.log("Generated Google Maps URL:", googleMapsUrl);
  window.open(googleMapsUrl, "_blank");
}

/**********************************************
 * MISC / STATE MANAGEMENT
 **********************************************/

/**
 * Resets the entire tool to its initial state (markers, UI fields, etc.).
 */
function refreshTool() {
  console.log("Refreshing tool state...");

  // Clear text fields
  document.getElementById("singleAddressInput").value = "";
  document.getElementById("start").value = "";
  document.getElementById("end").value = "";

  // Reset filters
  const stationFilter = document.getElementById("station-filter");
  if (stationFilter) {
    stationFilter.value = "all";
  }
  const priceFilter = document.getElementById("price-filter");
  if (priceFilter) {
    priceFilter.value = "all-prices";
  }
  const distanceFilter = document.getElementById("distance-filter");
  if (distanceFilter) {
    distanceFilter.value = "0";
  }

  // Hide filter section if open
  const filterSection = document.getElementById("filter-section");
  if (filterSection && !filterSection.classList.contains("hidden")) {
    filterSection.classList.add("hidden");
  }
  const toggleFiltersBtn = document.getElementById("toggleFilters");
  if (toggleFiltersBtn) {
    toggleFiltersBtn.classList.remove("active");
  }

  // Clear highlighted station list
  const highlightedStationsList = document.getElementById("highlightedStationsList");
  if (highlightedStationsList) {
    highlightedStationsList.innerHTML = "";
  }
  const highlightedStationsContainer = document.getElementById(
    "highlightedStationsContainer"
  );
  if (highlightedStationsContainer) {
    highlightedStationsContainer.style.display = "none";
  }

  // Reset markers
  gasStationMarkers.forEach((marker) => {
    marker.isWaypoint = false;
    marker.setIcon(marker.originalIcon);
    marker.setVisible(true);
  });

  // Clear any existing route from the map
  if (directionsRenderer) {
    directionsRenderer.setDirections({ routes: [] });
  }

  // Remove routeMarkers
  routeMarkers.forEach((marker) => marker.setMap(null));
  routeMarkers = [];

  // Hide the "Open in Google Maps" link
  const googleMapsLinkDiv = document.getElementById("openGoogleMapsRoute");
  if (googleMapsLinkDiv) {
    googleMapsLinkDiv.style.display = "none";
  }

  // Reset references
  currentRouteStart = "";
  currentRouteEnd = "";
  stationsAlongCurrentRoute = [];
  currentReferenceLocation = null;
  clearHighlights();
  activeHighlightedStations = [];

  // Close infoWindow if open
  if (infoWindow) {
    infoWindow.close();
  }

  // Adjust UI based on the current mode
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

/**
 * Sets up listeners for station/price/distance filter changes, re-applies filters when they change.
 */
function setupFilterListeners() {
  const stationFilter = document.getElementById("station-filter");
  const priceFilter = document.getElementById("price-filter");
  const distanceFilter = document.getElementById("distance-filter");
  const modeSelect = document.getElementById("modeSelect");

  if (stationFilter) {
    stationFilter.addEventListener("change", applyFilters);
  }
  if (priceFilter) {
    priceFilter.addEventListener("change", applyFilters);
  }
  if (distanceFilter) {
    distanceFilter.addEventListener("change", () => {
      // Only apply distance filter if a reference location is set (either single or route)
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

  /**
   * Toggles between "single" and "route" modes and updates UI accordingly.
   */
  function updateToolMode() {
    refreshTool();

    // Hide filter section by default
    const filterSection = document.getElementById("filter-section");
    if (filterSection) {
      filterSection.classList.add("hidden");
    }
    const toggleFiltersBtn = document.getElementById("toggleFilters");
    if (toggleFiltersBtn) {
      toggleFiltersBtn.classList.remove("active");
    }

    const mode = document.getElementById("modeSelect").value;
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

    // Clear out any highlighted stations in the side panel
    document.getElementById("highlightedStationsList").innerHTML = "";
    document.getElementById("highlightedStationsContainer").style.display = "none";

    // Reset icons for all markers to original
    gasStationMarkers.forEach((marker) => {
      marker.setIcon(
        {
          url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new google.maps.Size(22, 22),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        }
      );
      marker.setVisible(true);
    });

    // Reset the map to default
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
    document.getElementById("findStations").style.display =
      mode === "single" ? "inline-block" : "none";
    document.getElementById("calculateRoute").style.display =
      mode === "route" ? "inline-block" : "none";
  }

  // Default mode to "single" on load
  modeSelect.value = "single";
  updateToolMode();

  // Tab click events
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

  // Toggle filter panel
  const toggleFiltersButton = document.getElementById("toggleFilters");
  if (toggleFiltersButton) {
    toggleFiltersButton.addEventListener("click", () => {
      const filterSection = document.getElementById("filter-section");
      filterSection.classList.toggle("hidden");
      toggleFiltersButton.classList.toggle("active");
    });
  }

  // Refresh tool state
  const refreshBtn = document.getElementById("refreshTool");
  refreshBtn.addEventListener("click", refreshTool);

  // Display last updated time from Google Sheets
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
