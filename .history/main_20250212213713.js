/**********************************************
 * GLOBAL VARIABLES & INITIAL SETTINGS
 **********************************************/
let map;
let autoCompleteStart;
let autoCompleteEnd;
let autoCompleteSingle;
let directionsService = null;
let directionsRenderer = null;
let directionsServiceReady = false;
let isMapReady = false;

let gasStationMarkers = [];
let routeMarkers = [];
let stationsAlongCurrentRoute = [];

let currentRouteStart = "";
let currentRouteEnd = "";

let currentReferenceLocation = null;
let infoWindow;

// Global price range variables
let globalMinPrice = Infinity;
let globalMaxPrice = -Infinity;

// Google Sheets Info for fetching data
const spreadsheetId = "1wBdV3SB94eB5U49OWn2BQNGFQ8x8_O9SzUslIdqZ_2o";
const apiKey = "AIzaSyDYpNJXRFRuQq5IV8LQZi8E90r1gIaiORI";

/**********************************************
 * HELPER FUNCTIONS
 **********************************************/
/**
 * Fetches the last updated time from Google Sheets metadata.
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
 * Displays the last updated time in the footer.
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
 * Fetches location data (from Pilot and Casey CSVs), parses them with PapaParse,
 * and returns an array of location objects. Also updates globalMinPrice and globalMaxPrice.
 *
 * For Pilot stations, if the retail price is lower than the hauler's price,
 * we set the hauler's price equal to the retail price and remove the retail price.
 */
async function fetchLocations() {
  const pilotCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=606915630&single=true&output=csv";
  const caseyCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=1692662712&single=true&output=csv";

  try {
    const [pilotResponse, caseyResponse] = await Promise.all([
      fetch(pilotCSVUrl),
      fetch(caseyCSVUrl)
    ]);
    if (!pilotResponse.ok) throw new Error("Error loading Pilot data");
    if (!caseyResponse.ok) throw new Error("Error loading Casey data");

    const pilotCsvText = await pilotResponse.text();
    const caseyCsvText = await caseyResponse.text();

    const pilotData = Papa.parse(pilotCsvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    }).data;
    const caseyData = Papa.parse(caseyCsvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    }).data;

    const pilotLocations = pilotData
      .filter((row) => {
        return (
          row["Today's Price"] !== "Out of Network" &&
          row["Retail Price"] !== "Out of Network" &&
          row["Tomorrow's Price"] !== "Out of Network"
        );
      })
      .map((row) => {
        let haulerPrice = parseFloat(row["Today's Price"]?.replace("$", ""));
        let retailPrice = parseFloat(row["Retail Price"]?.replace("$", ""));
        // If retail price is lower than hauler price, set hauler price equal to retail and remove retail price.
        if (!isNaN(retailPrice) && !isNaN(haulerPrice) && retailPrice < haulerPrice) {
          haulerPrice = retailPrice;
          retailPrice = null;
        }
        if (!isNaN(haulerPrice)) {
          globalMinPrice = Math.min(globalMinPrice, haulerPrice);
          globalMaxPrice = Math.max(globalMaxPrice, haulerPrice);
        }
        return {
          locationNumberP: String(row["Location #"]),
          latP: parseFloat(row.Latitude),
          lngP: parseFloat(row.Longitude),
          cityP: row.City,
          stateP: row["State/Province"],
          todaysPriceP: haulerPrice,
          retailPriceP: retailPrice,
          tomorrowPriceP: parseFloat(row["Tomorrow's Price"]?.replace("$", "")),
          hyperlinkP: row.Hyperlink,
          typeP: "Pilot",
        };
      });

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
        typeC: "Casey",
      };
    });

    return [...pilotLocations, ...caseyLocations];
  } catch (error) {
    console.error("Error fetching locations:", error);
    return [];
  }
}

/**
 * Clears all markers from the map and resets the marker array.
 */
function clearMarkers(markerArray) {
  markerArray.forEach((marker) => marker.setMap(null));
  markerArray.length = 0;
}

/**********************************************
 * FILTERING FUNCTIONS
 **********************************************/
function filterStations(stations, userLocation) {
  if (!stations || stations.length === 0) {
    console.warn("⚠️ No stations to filter.");
    return [];
  }

  const selectedType = document.getElementById("station-filter").value.toLowerCase();
  console.log(`🔍 Selected Station Type: ${selectedType}`);

  const selectedPrice = document.getElementById("price-filter").value;
  let discountFilterActive = false,
      discountMin = 0,
      discountMax = Infinity;
  if (selectedPrice && selectedPrice !== "all-prices") {
    if (selectedPrice.indexOf("-") !== -1) {
      const parts = selectedPrice.split("-");
      if (parts.length >= 1) {
        discountMin = parseFloat(parts[0]) / 100;
        discountMax = parts[1] ? parseFloat(parts[1]) / 100 : Infinity;
        discountFilterActive = true;
      }
    }
  }
  console.log(`💲 Discount Filter Active: ${discountFilterActive}, Min: ${discountMin}, Max: ${discountMax}`);

  let maxDistance = Infinity;
  if (userLocation) {
    const selectedDistance = document.getElementById("distance-filter").value;
    maxDistance = selectedDistance !== "0" ? parseInt(selectedDistance) * 16093 : Infinity;
    console.log(`📏 Max Distance (meters): ${maxDistance}`);
  } else {
    console.log("📏 No reference location provided – skipping distance filtering.");
  }

  return stations.filter((marker) => {
    const matchesType =
      selectedType === "all" || marker.stationType.toLowerCase() === selectedType;

    let discount = 0;
    if (marker.stationType === "Pilot") {
      if (marker.retailPriceP != null && marker.todaysPriceP != null) {
        discount = marker.retailPriceP - marker.todaysPriceP;
      }
    } else if (marker.stationType === "Casey") {
      discount = 0;
    }
    const matchesDiscount = !discountFilterActive || (discount >= discountMin && discount < discountMax);

    let matchesDistance = true;
    if (userLocation) {
      const stationPosition = marker.getPosition();
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        userLocation,
        stationPosition
      );
      matchesDistance = distance <= maxDistance;
    }

    return matchesType && matchesDiscount && matchesDistance;
  });
}

function applyFilters() {
  if (!map) return;
  console.log("🔄 Reapplying filters...");
  const userLocation = currentReferenceLocation;
  gasStationMarkers.forEach(marker => marker.setVisible(false));

  const filteredStations = filterStations(gasStationMarkers, userLocation);
  filteredStations.forEach(marker => marker.setVisible(true));
  console.log(`✅ Filtered stations: ${filteredStations.length}`);
}

/**********************************************
 * MAP INITIALIZATION & MARKER FUNCTIONS
 **********************************************/
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
  const newMap = new google.maps.Map(mapContainer, mapOptions);

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
  directionsRenderer.setMap(newMap);

  newMap.addListener("zoom_changed", resizeMarkersBasedOnZoom);

  return newMap;
}

function setupAutocomplete() {
  console.log("Setting up autocomplete...");
  autoCompleteStart = new google.maps.places.Autocomplete(document.getElementById("start"));
  autoCompleteStart.addListener("place_changed", onPlaceChangedStart);

  autoCompleteEnd = new google.maps.places.Autocomplete(document.getElementById("end"));
  autoCompleteEnd.addListener("place_changed", onPlaceChangedEnd);

  autoCompleteSingle = new google.maps.places.Autocomplete(
    document.getElementById("singleAddressInput"),
    {
      types: ["geocode"],
      componentRestrictions: { country: "us" },
    }
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

  const locations = await fetchLocations();
  console.log(`Fetched ${locations.length} locations`);
  if (globalMinPrice === Infinity) globalMinPrice = 0;
  if (globalMaxPrice === -Infinity) globalMaxPrice = 100;
  plotLocationsOnMap(map, locations);

  setTimeout(() => google.maps.event.trigger(map, 'resize'), 100);

  console.log("✅ Google Maps initialized successfully.");
};

function plotLocationsOnMap(map, locations) {
  clearMarkers(gasStationMarkers);
  infoWindow = new google.maps.InfoWindow();
  let markerId = 0;

  locations.forEach((location) => {
    // Pilot markers
    if (location.latP && location.lngP) {
      const pilotMarker = new google.maps.Marker({
        position: { lat: location.latP, lng: location.lngP },
        map: map,
        title: `${location.cityP}, ${location.stateP}`,
        icon: {
          url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
          scaledSize: new google.maps.Size(16, 16),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        },
      });
      pilotMarker.stationType = "Pilot";
      pilotMarker.todaysPriceP = location.todaysPriceP;
      pilotMarker.retailPriceP = location.retailPriceP;
      pilotMarker.hyperlinkP = location.hyperlinkP;
      pilotMarker.cityP = location.cityP;
      pilotMarker.stateP = location.stateP;
      pilotMarker.originalIcon = pilotMarker.getIcon();
      pilotMarker.isWaypoint = false;
      pilotMarker.id = "marker-" + markerId++;

      // Marker click: show infoWindow, highlight card, and in route mode add the waypoint prompt to the card.
      pilotMarker.addListener("click", () => {
        infoWindow.setContent(
          `<div>
             <strong>Pilot Station</strong><br>
             <b>City:</b> ${location.cityP}, ${location.stateP}<br>
             <b>Hauler's Price:</b> $${location.todaysPriceP?.toFixed(2) || "N/A"}<br>
             <b>Retail Price:</b> ${location.retailPriceP ? "$" + location.retailPriceP.toFixed(2) : "N/A"}<br>
             <a href="${location.hyperlinkP}" target="_blank">Station Website</a>
           </div>`
        );
        infoWindow.open(map, pilotMarker);
        clearHighlights();
        highlightListItem(pilotMarker.id);
        if (document.getElementById("modeSelect").value === "route") {
          const card = document.querySelector(`.station-card[data-marker-id="${pilotMarker.id}"]`);
          if (card) {
            showCardWaypointPrompt(card, pilotMarker);
          }
        }
      });
      gasStationMarkers.push(pilotMarker);
    }

    // Casey markers
    if (location.latC && location.lngC) {
      const caseyMarker = new google.maps.Marker({
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
      caseyMarker.stationType = "Casey";
      caseyMarker.todaysPriceC = location.todaysPriceC;
      caseyMarker.cityC = location.cityC;
      caseyMarker.stateC = location.stateC;
      caseyMarker.originalIcon = caseyMarker.getIcon();
      caseyMarker.isWaypoint = false;
      caseyMarker.id = "marker-" + markerId++;

      caseyMarker.addListener("click", () => {
        infoWindow.setContent(
          `<div>
             <strong>Casey Station</strong><br>
             <b>City:</b> ${location.cityC}, ${location.stateC}<br>
             <b>Hauler's Price:</b> $${location.todaysPriceC?.toFixed(2) || "N/A"}<br>
             <b>Retail Price:</b> $${location.retailPriceC ? location.retailPriceC.toFixed(2) : "N/A"}<br>
           </div>`
        );
        infoWindow.open(map, caseyMarker);
        clearHighlights();
        highlightListItem(caseyMarker.id);
        if (document.getElementById("modeSelect").value === "route") {
          const card = document.querySelector(`.station-card[data-marker-id="${caseyMarker.id}"]`);
          if (card) {
            showCardWaypointPrompt(card, caseyMarker);
          }
        }
      });
      gasStationMarkers.push(caseyMarker);
    }
  });
}

function updateMarkerAsWaypoint(marker) {
  marker.isWaypoint = true;
  marker.setIcon({
    url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
    scaledSize: new google.maps.Size(30, 30),
    origin: new google.maps.Point(0, 0),
    anchor: new google.maps.Point(15, 30)
  });
  clearHighlights();
  highlightListItem(marker.id);
}

function updateMarkerAsNotWaypoint(marker) {
  marker.isWaypoint = false;
  marker.setIcon({
    url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
    scaledSize: new google.maps.Size(22, 22),
    origin: new google.maps.Point(0, 0),
    anchor: new google.maps.Point(11, 22)
  });
  clearHighlights();
  highlightListItem(marker.id);
}

/**
 * Inserts (or toggles off) a yes/no prompt inside a Truck Stops Nearby card.
 * If the prompt already exists, clicking the card again will remove it.
 */
function showCardWaypointPrompt(card, marker) {
  const existingPrompt = card.querySelector(".card-prompt");
  if (existingPrompt) {
    existingPrompt.remove();
    return;
  }
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

function clearHighlights() {
  const stationCards = document.querySelectorAll(".station-card");
  stationCards.forEach(card => card.classList.remove("highlight"));
}

function highlightListItem(markerId) {
  const card = document.querySelector(`.station-card[data-marker-id="${markerId}"]`);
  if (card) {
    card.classList.add("highlight");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

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
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        center,
        marker.getPosition()
      );
      marker.distance = distance;
    });

    const radiusInMeters = 80467;
    let stationsInRange = gasStationMarkers.filter(
      (marker) => marker.distance <= radiusInMeters
    );

    stationsInRange = filterStations(stationsInRange, center);
    console.log(`🔍 Stations after filtering: ${stationsInRange.length}`);

    stationsInRange.forEach((marker) => {
      marker.setIcon({
        url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
        scaledSize: new google.maps.Size(22, 22),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(11, 22),
      });
      marker.setVisible(true);
    });

    const highlightedStationsContainer = document.getElementById("highlightedStationsContainer");
    const highlightedStationsList = document.getElementById("highlightedStationsList");
    highlightedStationsList.innerHTML = "";
    if (stationsInRange.length > 0) {
      stationsInRange.forEach((marker) => {
        const li = document.createElement("li");
        li.className = "station-card";
        li.setAttribute("data-marker-id", marker.id);

        const stationType = marker.stationType;
        let stationLabel = stationType === "Pilot" ? "Pilot Station" : "Casey Station";
        let city = stationType === "Pilot" ? marker.cityP : marker.cityC;
        let state = stationType === "Pilot" ? marker.stateP : marker.stateC;
        let todaysPrice = stationType === "Pilot" ? marker.todaysPriceP : marker.todaysPriceC;
        let retailPrice = stationType === "Pilot" ? marker.retailPriceP : marker.retailPriceC;
        if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);
        if (retailPrice != null) retailPrice = retailPrice.toFixed(2);

        li.innerHTML = `
          <h4>${stationLabel}</h4>
          <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
          <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
          <p>Retail Price: $${retailPrice ?? "N/A"}</p>
        `;
        // In route mode, clicking the card triggers the marker's infoWindow and adds the waypoint prompt.
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

    for (let i = 0; i < routePolyline.length - 1; i++) {
      const segmentStart = routePolyline[i];
      const distance = google.maps.geometry.spherical.computeDistanceBetween(markerPosition, segmentStart);
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

      const stationType = marker.stationType;
      let stationLabel = stationType === "Pilot" ? "Pilot Station" : "Casey Station";
      let city = stationType === "Pilot" ? marker.cityP : marker.cityC;
      let state = stationType === "Pilot" ? marker.stateP : marker.stateC;
      let todaysPrice = stationType === "Pilot" ? marker.todaysPriceP : marker.todaysPriceC;
      let retailPrice = stationType === "Pilot" ? marker.retailPriceP : marker.retailPriceC;
      if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);
      if (retailPrice != null) retailPrice = retailPrice.toFixed(2);

      li.innerHTML = `
        <h4>${stationLabel}</h4>
        <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
        <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
        <p>Retail Price: $${retailPrice ?? "N/A"}</p>
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

  let selectedMarkers = gasStationMarkers.filter(m => m.isWaypoint);
  console.log("Number of markers flagged as waypoints:", selectedMarkers.length);

  if (selectedMarkers.length === 0 && stationsAlongCurrentRoute.length > 0) {
    selectedMarkers = stationsAlongCurrentRoute;
    console.log("Using stationsAlongCurrentRoute. Count:", selectedMarkers.length);
  }

  if (selectedMarkers.length === 0) {
    alert("No stations found to include as waypoints.");
    return;
  }

  const waypointCoords = selectedMarkers.map(marker => {
    const pos = marker.getPosition();
    return `${pos.lat()},${pos.lng()}`;
  });
  console.log("Waypoint coordinates:", waypointCoords);

  const googleMapsUrl = buildGoogleMapsLink(currentRouteStart, currentRouteEnd, waypointCoords);
  console.log("Generated Google Maps URL:", googleMapsUrl);
  window.open(googleMapsUrl, "_blank");
}

function refreshTool() {
  console.log("Refreshing tool state...");

  document.getElementById("singleAddressInput").value = "";
  document.getElementById("start").value = "";
  document.getElementById("end").value = "";

  const stationFilter = document.getElementById("station-filter");
  if (stationFilter) { stationFilter.value = "all"; }
  const priceFilter = document.getElementById("price-filter");
  if (priceFilter) { priceFilter.value = "all-prices"; }
  const distanceFilter = document.getElementById("distance-filter");
  if (distanceFilter) { distanceFilter.value = "0"; }
  
  const filterSection = document.getElementById("filter-section");
  if (filterSection && !filterSection.classList.contains("hidden")) {
    filterSection.classList.add("hidden");
  }
  const toggleFiltersBtn = document.getElementById("toggleFilters");
  if (toggleFiltersBtn) { toggleFiltersBtn.classList.remove("active"); }

  const highlightedStationsList = document.getElementById("highlightedStationsList");
  if (highlightedStationsList) { highlightedStationsList.innerHTML = ""; }
  const highlightedStationsContainer = document.getElementById("highlightedStationsContainer");
  if (highlightedStationsContainer) { highlightedStationsContainer.style.display = "none"; }

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
  if (googleMapsLinkDiv) { googleMapsLinkDiv.style.display = "none"; }

  currentRouteStart = "";
  currentRouteEnd = "";
  stationsAlongCurrentRoute = [];
  currentReferenceLocation = null;

  clearHighlights();

  if (infoWindow) { infoWindow.close(); }

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

  if (stationFilter) { stationFilter.addEventListener("change", applyFilters); }
  if (priceFilter) { priceFilter.addEventListener("change", applyFilters); }
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

document.addEventListener("DOMContentLoaded", () => {
  const modeSelect = document.getElementById("modeSelect");
  const singleAddressTool = document.getElementById("singleAddressTool");
  const routeTool = document.getElementById("routeTool");
  const tabSingle = document.getElementById("tabSingle");
  const tabRoute = document.getElementById("tabRoute");

  function updateToolMode() {
    refreshTool();
  
    const filterSection = document.getElementById("filter-section");
    if (filterSection) { filterSection.classList.add("hidden"); }
    const toggleFiltersBtn = document.getElementById("toggleFilters");
    if (toggleFiltersBtn) { toggleFiltersBtn.classList.remove("active"); }
  
    const mode = document.getElementById("modeSelect").value;
    const distanceFilter = document.getElementById("distance-filter");
    if (mode === "route") {
      if (distanceFilter) { distanceFilter.disabled = true; }
      document.getElementById("singleAddressTool").style.display = "none";
      document.getElementById("routeTool").style.display = "block";
    } else {
      if (distanceFilter) { distanceFilter.disabled = false; }
      document.getElementById("singleAddressTool").style.display = "block";
      document.getElementById("routeTool").style.display = "none";
      document.getElementById("map-container").style.display = "block";
      if (!map) {
        console.log("No map detected in single mode—calling initMap()");
        initMap();
      }
    }
  
    document.getElementById("highlightedStationsList").innerHTML = "";
    document.getElementById("highlightedStationsContainer").style.display = "none";
    gasStationMarkers.forEach((marker) => {
      marker.setIcon(
        marker.stationType === "Pilot"
          ? {
              url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
              scaledSize: new google.maps.Size(22, 22),
              origin: new google.maps.Point(0, 0),
              anchor: new google.maps.Point(8, 16),
            }
          : {
              url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
              scaledSize: new google.maps.Size(22, 22),
              origin: new google.maps.Point(0, 0),
              anchor: new google.maps.Point(8, 16),
            }
      );
      marker.setVisible(true);
    });
    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 });
      map.setZoom(4.5);
      if (directionsRenderer) { directionsRenderer.setDirections({ routes: [] }); }
      routeMarkers.forEach((marker) => marker.setMap(null));
      routeMarkers = [];
    }
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

  displayLastUpdatedTime();
});

window.addEventListener("load", () => {
  if (!isMapReady) {
    console.log("Window loaded: calling initMap as fallback.");
    initMap();
  }
});
