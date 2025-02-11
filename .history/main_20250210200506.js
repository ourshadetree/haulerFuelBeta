let map;
let autoCompleteStart;
let autoCompleteEnd;
let routeControl;
let gasStationMarkers = [];
let pilotMarkers = [];
let caseyMarkers = [];
let areStationsVisible = true;
let directionsService = null;
let directionsRenderer = null;
let directionsServiceReady = false;
let isMapReady = false;
let autoCompleteSingle;
let routeMarkers = [];
let priceSlider; // Global variable for our price range slider
let distanceSlider; // Global variable for our distance slider

// Store the current route's start & end for building a shareable link
let currentRouteStart = "";
let currentRouteEnd = "";

// We store the stations near the current route here
let stationsAlongCurrentRoute = [];

// Google Sheets Info
const spreadsheetId = "1wBdV3SB94eB5U49OWn2BQNGFQ8x8_O9SzUslIdqZ_2o";
const apiKey = "AIzaSyDYpNJXRFRuQq5IV8LQZi8E90r1gIaiORI";

// Function to fetch the last modified time from the Google Sheets API
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

document.addEventListener("DOMContentLoaded", () => {
  const modeSelect = document.getElementById("modeSelect");
  const singleAddressTool = document.getElementById("singleAddressTool");
  const routeTool = document.getElementById("routeTool");
  const stationTypeCheckboxes = document.querySelectorAll(
    '#stationTypeFilter input[name="stationType"]'
  );

  stationTypeCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", function () {
      if (this.checked) {
        stationTypeCheckboxes.forEach((otherCheckbox) => {
          if (otherCheckbox !== this) {
            otherCheckbox.checked = false;
          }
        });
      } else {
        // If the user unchecks and no box is checked, default to "all"
        let anyChecked = Array.from(stationTypeCheckboxes).some((chk) => chk.checked);
        if (!anyChecked) {
          document.querySelector('#stationTypeFilter input[value="all"]').checked = true;
        }
      }
    });
  });

  const toggleFiltersButton = document.getElementById("toggleFilters");
  if (toggleFiltersButton) {
    toggleFiltersButton.addEventListener("click", toggleFilters);
  }

  function updateToolMode() {
    const mode = modeSelect.value;

    if (mode === "single") {
      singleAddressTool.style.display = "block";
      routeTool.style.display = "none";
    } else {
      singleAddressTool.style.display = "none";
      routeTool.style.display = "block";
    }

    const highlightedStationsList = document.getElementById("highlightedStationsList");
    const highlightedStationsContainer = document.getElementById("highlightedStationsContainer");
    if (highlightedStationsList) highlightedStationsList.innerHTML = "";
    if (highlightedStationsContainer) highlightedStationsContainer.style.display = "none";

    // Reset marker icons & visibility
    gasStationMarkers.forEach((marker) => {
      if (marker.stationType === "Pilot") {
        marker.setIcon({
          url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
          scaledSize: new google.maps.Size(22, 22),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        });
      } else {
        marker.setIcon({
          url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new google.maps.Size(22, 22),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(8, 16),
        });
      }
      marker.setVisible(true);
    });

    // Reset map & route markers
    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 });
      map.setZoom(4.5);

      if (directionsRenderer) {
        directionsRenderer.setDirections({ routes: [] });
      }

      routeMarkers.forEach((marker) => marker.setMap(null));
      routeMarkers = [];
    }

    const runBtn = document.getElementById("findStations");
    const routeBtn = document.getElementById("calculateRoute");

    if (mode === "single") {
      runBtn.style.display = "inline-block";
      routeBtn.style.display = "none";
    } else {
      runBtn.style.display = "none";
      routeBtn.style.display = "inline-block";
    }
  }

  modeSelect.value = "single";
  updateToolMode();
  modeSelect.addEventListener("change", updateToolMode);

  // Ensure the filters are hidden by default by adding the "hidden" class.
  const filterSection = document.getElementById("filter-section");
  if (filterSection) {
    filterSection.classList.add("hidden");
  }
});

// Toggle the "hidden" class on the filter section when the button is clicked.
function toggleFilters() {
  const filterSection = document.getElementById("filter-section");
  if (filterSection) {
    console.log("Toggling filters. Before:", filterSection.className);
    filterSection.classList.toggle("hidden");
    console.log("After:", filterSection.className);
  }
}

function filterStations(stations) {
  // Get station type from checkboxes
  const checkedBoxes = Array.from(
    document.querySelectorAll('#stationTypeFilter input[name="stationType"]:checked')
  );
  const checkedTypes = checkedBoxes.map((box) => box.value.toLowerCase());
  const filterAll = checkedTypes.includes("all");
  if (checkedTypes.length === 0) {
    checkedTypes.push("all");
  }

  // Get distance filter from the slider.
  let distanceFilterMiles = 50;
  if (distanceSlider && distanceSlider.noUiSlider) {
    distanceFilterMiles = parseFloat(distanceSlider.noUiSlider.get());
  }
  const distanceFilter = distanceFilterMiles * 1609.34; // Convert miles to meters

  // Price filter
  let priceLow = 0,
    priceHigh = Infinity;
  if (priceSlider && priceSlider.noUiSlider) {
    const priceValues = priceSlider.noUiSlider.get(); // [low, high]
    priceLow = parseFloat(priceValues[0]);
    priceHigh = parseFloat(priceValues[1]);
  }

  console.log("🔍 Checking filters:");
  console.log("   Checked Station Types:", checkedTypes);
  console.log("   Price Range: $", priceLow, "-", priceHigh);
  console.log("   Distance Filter (meters):", distanceFilter);

  const filteredStations = stations.filter((station) => {
    let matchesPrice = true;
    let matchesStationType = true;
    let matchesDistance = true;

    // Station's price (from Pilot or Casey)
    let stationPrice = station.todaysPriceP || station.todaysPriceC || null;
    if (stationPrice !== null) {
      // Compare stationPrice with the slider range
      if (stationPrice < priceLow || stationPrice > priceHigh) {
        matchesPrice = false;
      }
    } else {
      console.warn("❌ Station skipped due to missing price (Price filter active)");
      return false;
    }

    // Station Type Filtering:
    if (filterAll) {
      matchesStationType = true;
    } else {
      const stationTypeLower = (station.stationType || "").toLowerCase();
      matchesStationType = checkedTypes.includes(stationTypeLower);
      if (!matchesStationType) {
        console.warn("❌ Station skipped due to Station Type filter");
      }
    }

    // Distance Filtering:
    if (distanceFilter !== null) {
      if (station.distance !== undefined) {
        matchesDistance = station.distance <= distanceFilter;
      } else {
        console.warn("❌ Station skipped due to missing distance (Distance filter active)");
        return false;
      }
    }

    return matchesPrice && matchesStationType && matchesDistance;
  });

  console.log(`🔎 Filter applied - Stations remaining: ${filteredStations.length}`);
  return filteredStations;
}

// Global variables to hold the computed global price range
let globalMinPrice = Infinity;
let globalMaxPrice = -Infinity;

// Function to display the last updated time in the footer
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

displayLastUpdatedTime();

// Fetch location data from Google Sheets
async function fetchLocations() {
  const pilotCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=606915630&single=true&output=csv";
  const caseyCSVUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS54WS48Ol3EXpqVS-2Rw7ePnqwFcnkiVzfONIGxIJqpWuruNuphr_qhpNFbVgHVrchKyjkCBfjM_zK/pub?gid=1692662712&single=true&output=csv";

  try {
    const pilotResponse = await fetch(pilotCSVUrl);
    if (!pilotResponse.ok) throw new Error("Error loading Pilot data");
    const caseyResponse = await fetch(caseyCSVUrl);
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
        let price = parseFloat(row["Today's Price"]?.replace("$", ""));
        if (!isNaN(price)) {
          globalMinPrice = Math.min(globalMinPrice, price);
          globalMaxPrice = Math.max(globalMaxPrice, price);
        }
        return {
          locationNumberP: String(row["Location #"]),
          latP: parseFloat(row.Latitude),
          lngP: parseFloat(row.Longitude),
          cityP: row.City,
          stateP: row["State/Province"],
          todaysPriceP: price,
          retailPriceP: parseFloat(row["Retail Price"]?.replace("$", "")),
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

// Initialize the distance slider (range: 1 to 50 miles)
function initializeDistanceSlider() {
  const distanceSliderElement = document.getElementById("distanceSlider");

  if (distanceSlider && distanceSlider.noUiSlider) {
    // If the slider already exists, just update
    distanceSlider.noUiSlider.updateOptions({
      range: { min: 1, max: 50 },
      start: [50], // default to 50 miles
    });
  } else {
    noUiSlider.create(distanceSliderElement, {
      start: [50],
      connect: [true, false],
      range: {
        min: 1,
        max: 50,
      },
      step: 1,
      tooltips: true,
      format: {
        to: (value) => Math.round(value),
        from: (value) => Number(value),
      },
    });
    distanceSlider = distanceSliderElement;
    // Update display whenever the slider value changes.
    distanceSlider.noUiSlider.on("update", (values, handle) => {
      document.getElementById("distanceSliderDisplay").textContent = `Distance: ${values[0]} mile(s)`;
    });
  }
}

window.initMap = async function initMap() {
  const mapOptions = {
    center: { lat: 39.8283, lng: -98.5795 },
    zoom: 4.5,
  };

  map = new google.maps.Map(document.getElementById("map"), mapOptions);
  directionsService = new google.maps.DirectionsService();

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
    console.log("Selected Place:", place);
  });

  directionsRenderer = new google.maps.DirectionsRenderer();
  directionsRenderer.setMap(map);

  directionsServiceReady = true;
  isMapReady = true;

  map.addListener("zoom_changed", resizeMarkersBasedOnZoom);

  document.addEventListener("DOMContentLoaded", () => {
    const inputs = ["singleAddressInput", "start", "end"];
    inputs.forEach((id) => {
      const inputField = document.getElementById(id);
      if (inputField) {
        inputField.setAttribute("autocomplete", "off");
        inputField.setAttribute("name", "no-autocomplete");
        inputField.addEventListener("focus", () => {
          inputField.setAttribute("autocomplete", "new-password");
        });
      }
    });

    // When user clicks "Create Route"
    document.getElementById("calculateRoute").addEventListener("click", async () => {
      if (directionsServiceReady) {
        await performRoute();
      }
    });

    // When user clicks "Open This Route in Google Maps"
    document
      .getElementById("openGoogleMapsRoute")
      .addEventListener("click", openGoogleMapsRoute);
  });

  // Fetch & plot locations
  const locations = await fetchLocations();

  // If no valid global min/max, set defaults
  if (globalMinPrice === Infinity) globalMinPrice = 0;
  if (globalMaxPrice === -Infinity) globalMaxPrice = 100;
  initializePriceSlider(globalMinPrice, globalMaxPrice);

  initializeDistanceSlider();
  plotLocationsOnMap(map, locations);
};

function initializePriceSlider(min, max) {
  const sliderElement = document.getElementById("priceRangeSlider");
  if (priceSlider && priceSlider.noUiSlider) {
    priceSlider.noUiSlider.updateOptions({
      range: { min: min, max: max },
      start: [min, max],
    });
  } else {
    noUiSlider.create(sliderElement, {
      start: [min, max],
      connect: true,
      range: {
        min: min,
        max: max,
      },
      tooltips: true,
      format: {
        to: (value) => parseFloat(value).toFixed(2),
        from: (value) => parseFloat(value),
      },
    });
    priceSlider = sliderElement;
    priceSlider.noUiSlider.on("update", (values, handle) => {
      document.getElementById(
        "priceRangeDisplay"
      ).textContent = `Price Range: $${values[0]} - $${values[1]}`;
    });
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

    // Hide all markers initially
    gasStationMarkers.forEach((marker) => marker.setVisible(false));

    // Compute each marker's distance from the address
    gasStationMarkers.forEach((marker) => {
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        center,
        marker.getPosition()
      );
      marker.distance = distance;
    });

    // 50 miles in meters (or replace with your distance slider logic)
    const radiusInMeters = 80467;
    let stationsInRange = gasStationMarkers.filter(
      (marker) => marker.distance <= radiusInMeters
    );

    // Filter by price, station type, etc.
    stationsInRange = filterStations(stationsInRange);
    console.log(`🔍 Stations after filtering: ${stationsInRange.length}`);

    // Make them visible & set icon to green
    stationsInRange.forEach((marker) => {
      marker.setIcon({
        url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
        scaledSize: new google.maps.Size(22, 22),
        origin: new google.maps.Point(0, 0),
        anchor: new google.maps.Point(11, 22),
      });
      marker.setVisible(true);
    });

    // Populate the Truck Stops Nearby list
    const highlightedStationsParent = document.getElementById("highlightedStationsContainer");
    const highlightedStationsContainer = document.getElementById("highlightedStationsList");
    highlightedStationsContainer.innerHTML = ""; // Clear existing

    if (stationsInRange.length > 0) {
      stationsInRange.forEach((marker) => {
        const li = document.createElement("li");
        li.className = "station-card";

        // Identify whether it's Pilot or Casey
        const stationType = marker.stationType; // "Pilot" or "Casey"
        let stationLabel = (stationType === "Pilot") ? "Pilot Station" : "Casey Station";
        // City / State
        let city = (stationType === "Pilot") ? marker.cityP : marker.cityC;
        let state = (stationType === "Pilot") ? marker.stateP : marker.stateC;
        // Today's Price
        let todaysPrice = (stationType === "Pilot") ? marker.todaysPriceP : marker.todaysPriceC;
        if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);
        // Retail Price (Pilot only, if not null)
        let retailPrice = (stationType === "Pilot") ? marker.retailPriceP : null;
        let retailPriceDisplay = "N/A";
        if (retailPrice != null && !isNaN(retailPrice)) {
          retailPriceDisplay = retailPrice.toFixed(2);
        }

        li.innerHTML = `
          <h4>${stationLabel}</h4>
          <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
          <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
          <p>Retail Price: $${retailPriceDisplay}</p>
        `;
        highlightedStationsContainer.appendChild(li);
      });

      highlightedStationsParent.style.display = "block";

      // Center map around the address
      map.setCenter(center);
      map.setZoom(10);
    } else {
      highlightedStationsParent.style.display = "none";
      alert("No stations found near the entered address.");
    }
  } catch (error) {
    console.error(error);
    alert("Could not find gas stations for the entered address.");
  }
}

async function highlightStationsAlongRoute(routePolyline) {
  const bufferDistance = 5000; // 5 km (~3 miles)
  const highlightedStationsContainer = document.getElementById("highlightedStationsList");
  const highlightedStationsParent = document.getElementById("highlightedStationsContainer");
  highlightedStationsContainer.innerHTML = "";

  // Hide all markers initially
  gasStationMarkers.forEach((marker) => marker.setVisible(false));

  let stationsNearRoute = [];
  gasStationMarkers.forEach((marker) => {
    const markerPosition = marker.getPosition();
    let isNearRoute = false;
    let minDistance = Infinity;

    for (let i = 0; i < routePolyline.length - 1; i++) {
      const segmentStart = routePolyline[i];
      const distance = google.maps.geometry.spherical.computeDistanceBetween(
        markerPosition,
        segmentStart
      );
      if (distance <= bufferDistance) {
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
  stationsNearRoute = filterStations(stationsNearRoute);
  console.log(`🔍 Stations after filtering: ${stationsNearRoute.length}`);

  // Update the global array
  stationsAlongCurrentRoute = stationsNearRoute;

  if (stationsNearRoute.length > 0) {
    stationsNearRoute.forEach((marker) => {
      // Only change icon if not yet selected as a waypoint
      if (!marker.isWaypoint) {
        marker.setIcon({
          url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png",
          scaledSize: new google.maps.Size(22, 22),
          origin: new google.maps.Point(0, 0),
          anchor: new google.maps.Point(11, 22),
        });
      }
      marker.setVisible(true);

      // ---- Populate the "Truck Stops Nearby" list ----
      const li = document.createElement("li");
      li.className = "station-card";

      const stationType = marker.stationType; // "Pilot" or "Casey"
      let stationLabel = (stationType === "Pilot") ? "Pilot Station" : "Casey Station";

      let city = (stationType === "Pilot") ? marker.cityP : marker.cityC;
      let state = (stationType === "Pilot") ? marker.stateP : marker.stateC;

      let todaysPrice = (stationType === "Pilot") ? marker.todaysPriceP : marker.todaysPriceC;
      if (todaysPrice != null) todaysPrice = todaysPrice.toFixed(2);

      let retailPrice = (stationType === "Pilot") ? marker.retailPriceP : null;
      let retailPriceDisplay = "N/A";
      if (retailPrice != null && !isNaN(retailPrice)) {
        retailPriceDisplay = retailPrice.toFixed(2);
      }

      li.innerHTML = `
        <h4>${stationLabel}</h4>
        <p>City, State: ${city ?? "Unknown City"}, ${state ?? "Unknown State"}</p>
        <p>Today's Price: $${todaysPrice ?? "N/A"}</p>
        <p>Retail Price: $${retailPriceDisplay}</p>
      `;
      highlightedStationsContainer.appendChild(li);
    });
    highlightedStationsParent.style.display = "block";
  } else {
    highlightedStationsParent.style.display = "none";
  }
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

async function performRoute() {
  if (!isMapReady || !directionsService || !directionsRenderer) {
    console.error("Map, DirectionsService, or DirectionsRenderer is not ready.");
    return;
  }
  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();
  if (!start && !end) {
    alert("Please enter at least one address.");
    return;
  }
  // Keep track of current route addresses
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
    const routePolyline = result.routes[0].overview_path;
    await highlightStationsAlongRoute(routePolyline);

    // Show the "Open This Route in Google Maps" button now that we have a route
    document.getElementById("googleMapsLinkContainer").style.display = "block";
    document.getElementById("highlightedStationsContainer").style.display = "block";
  } catch (error) {
    console.error("Error calculating route:", error);
    alert("Route calculation failed: " + error);
  }
}

function plotLocationsOnMap(map, locations) {
  clearMarkers(gasStationMarkers);
  gasStationMarkers = [];
  const infoWindow = new google.maps.InfoWindow();

  locations.forEach((location, index) => {
    // Pilot marker
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

      // Store station info
      pilotMarker.stationType = "Pilot";
      pilotMarker.todaysPriceP = location.todaysPriceP;
      pilotMarker.tomorrowPriceP = location.tomorrowPriceP;
      pilotMarker.retailPriceP = location.retailPriceP;
      pilotMarker.hyperlinkP = location.hyperlinkP;

      // ------ IMPORTANT: set city/state for Single Address & Route listing ------
      pilotMarker.cityP = location.cityP;
      pilotMarker.stateP = location.stateP;

      // Keep track of original icon in case we toggle
      pilotMarker.originalIcon = pilotMarker.getIcon();
      pilotMarker.isWaypoint = false; // Not selected by default

      pilotMarker.addListener("click", () => {
        // 1) Show station info
        infoWindow.setContent(
          `<div>
            <strong>Pilot Station</strong><br>
            <b>City:</b> ${location.cityP}, ${location.stateP}<br>
            <b>Hauler's Price:</b> $${location.todaysPriceP?.toFixed(2) || "N/A"}<br>
            <b>Retail Price:</b> $${location.retailPriceP?.toFixed(2) || "N/A"}<br>
            <a href="${location.hyperlinkP}" target="_blank">Station Website</a>
          </div>`
        );
        infoWindow.open(map, pilotMarker);

        // 2) Toggle waypoint status
        toggleWaypoint(pilotMarker);
      });

      gasStationMarkers.push(pilotMarker);
    }

    // Casey marker
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

      // Store station info
      caseyMarker.stationType = "Casey";
      caseyMarker.todaysPriceC = location.todaysPriceC;
      caseyMarker.tomorrowPriceC = location.tomorrowPriceC;

      // ------ IMPORTANT: set city/state for Single Address & Route listing ------
      caseyMarker.cityC = location.cityC;
      caseyMarker.stateC = location.stateC;

      // Keep track of original icon in case we toggle
      caseyMarker.originalIcon = caseyMarker.getIcon();
      caseyMarker.isWaypoint = false; // Not selected by default

      caseyMarker.addListener("click", () => {
        // Show station info
        infoWindow.setContent(
          `<div>
            <strong>Casey Station</strong><br>
            <b>City:</b> ${location.cityC}, ${location.stateC}<br>
            <b>Hauler's Price:</b> $${location.todaysPriceC?.toFixed(2) || "N/A"}<br>
          </div>`
        );
        infoWindow.open(map, caseyMarker);

        // Toggle waypoint status
        toggleWaypoint(caseyMarker);
      });

      gasStationMarkers.push(caseyMarker);
    }
  });
}

// Toggle marker as a waypoint
function toggleWaypoint(marker) {
  marker.isWaypoint = !marker.isWaypoint;
  if (marker.isWaypoint) {
    // Mark as selected with a purple icon
    marker.setIcon({
      url: "http://maps.google.com/mapfiles/ms/icons/purple-dot.png",
      scaledSize: new google.maps.Size(22, 22),
      origin: new google.maps.Point(0, 0),
      anchor: new google.maps.Point(11, 22),
    });
  } else {
    // Revert to the original icon
    marker.setIcon(marker.originalIcon);
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

function refreshTool() {
  document.getElementById("singleAddressInput").value = "";
  document.getElementById("start").value = "";
  document.getElementById("end").value = "";

  const highlightedStationsList = document.getElementById("highlightedStationsList");
  const highlightedStationsContainer = document.getElementById(
    "highlightedStationsContainer"
  );
  if (highlightedStationsList) highlightedStationsList.innerHTML = "";
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

  // Hide the Google Maps link button until a route is made again
  document.getElementById("googleMapsLinkContainer").style.display = "none";

  // Clear out the route-based stations
  stationsAlongCurrentRoute = [];

  if (map) {
    map.setCenter({ lat: 39.8283, lng: -98.5795 });
    map.setZoom(4.5);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = document.getElementById("refreshTool");
  refreshBtn.addEventListener("click", refreshTool);
});

function clearMarkers(markerArray) {
  markerArray.forEach((marker) => marker.setMap(null));
  markerArray.length = 0;
}

// Build a Google Maps Directions URL using start, end, and any selected waypoints
function buildGoogleMapsLink(origin, destination, waypointsArray) {
  const baseUrl = "https://www.google.com/maps/dir/?api=1";
  const originParam = `origin=${encodeURIComponent(origin)}`;
  const destinationParam = `destination=${encodeURIComponent(destination)}`;
  const travelModeParam = `travelmode=driving`;

  let waypointsParam = "";
  if (waypointsArray.length > 0) {
    // Example: "waypoints=LAT,LNG|LAT,LNG"
    const joined = waypointsArray.join("|");
    waypointsParam = `&waypoints=${encodeURIComponent(joined)}`;
  }

  return `${baseUrl}&${originParam}&${destinationParam}&${travelModeParam}${waypointsParam}`;
}

// Open the route in Google Maps with waypoints
function openGoogleMapsRoute() {
  if (!currentRouteStart || !currentRouteEnd) {
    alert("No valid route to open. Please create a route first.");
    return;
  }

  // Gather all markers that the user selected (isWaypoint = true)
  let selectedMarkers = gasStationMarkers.filter((m) => m.isWaypoint);

  // If user hasn't chosen specific stations, default to all stations along the route
  if (selectedMarkers.length === 0 && stationsAlongCurrentRoute.length > 0) {
    selectedMarkers = stationsAlongCurrentRoute;
  }

  // If we STILL have no markers, there's nothing to show
  if (selectedMarkers.length === 0) {
    alert("No stations found to include as waypoints.");
    return;
  }

  // Convert each marker's lat/lng to a "lat,lng" string
  const waypointCoords = selectedMarkers.map((marker) => {
    const pos = marker.getPosition();
    return `${pos.lat()},${pos.lng()}`;
  });

  const googleMapsUrl = buildGoogleMapsLink(currentRouteStart, currentRouteEnd, waypointCoords);
  console.log("Generated Google Maps URL:", googleMapsUrl);

  // Open in a new tab (or mobile Maps app)
  window.open(googleMapsUrl, "_blank");
}

// Ensure the openGoogleMapsRoute button is bound
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("openGoogleMapsRoute");
  console.log("Button found:", btn);
  btn.addEventListener("click", openGoogleMapsRoute);
});

window.addEventListener("load", initMap);
