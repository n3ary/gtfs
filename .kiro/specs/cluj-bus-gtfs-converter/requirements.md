# Requirements Document

## Introduction

The Cluj Bus GTFS Converter is a CLI tool that fetches offline bus schedules from Cluj-Napoca's public transport website (ctpcj.ro), converts them to GTFS (General Transit Feed Specification) format, and generates a public GTFS feed consumable by transit routing applications like Tranzy.ai. The tool supports automated weekly updates to maintain schedule accuracy.

## Glossary

- **CLI_Tool**: The command-line interface application that orchestrates data fetching, conversion, and GTFS generation
- **Data_Fetcher**: The component responsible for retrieving schedule data from ctpcj.ro
- **Schedule_Parser**: The component that extracts structured schedule information from HTML or PDF sources
- **GTFS_Generator**: The component that converts parsed schedule data into GTFS format files
- **GTFS_Validator**: The component that verifies the generated GTFS feed complies with the specification
- **GTFS_Feed**: The collection of text files (agency.txt, stops.txt, routes.txt, trips.txt, stop_times.txt, calendar.txt, shapes.txt) packaged as gtfs.zip
- **CTP_Website**: The Cluj-Napoca public transport authority website at https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane
- **Route**: A bus line (e.g., Linia 1, Linia 2) with defined endpoints and stops
- **Trip**: A specific instance of a route at a scheduled time
- **Stop**: A physical bus stop location with coordinates and identifier

## Requirements

### Requirement 1: Fetch Schedule Data from CTP Website

**User Story:** As a transit data maintainer, I want to fetch current bus schedules from the CTP Cluj website, so that I have the latest schedule information for conversion.

#### Acceptance Criteria

1. WHEN the CLI_Tool is invoked with a fetch command, THE Data_Fetcher SHALL retrieve the route list from the CTP_Website
2. WHEN retrieving route information, THE Data_Fetcher SHALL extract route names, numbers, and endpoint information for all urban bus lines
3. WHEN a route page is accessed, THE Data_Fetcher SHALL download schedule data in the available format (HTML tables or PDF files)
4. IF the CTP_Website is unreachable, THEN THE Data_Fetcher SHALL return a descriptive error message and exit gracefully
5. WHEN fetching completes successfully, THE Data_Fetcher SHALL store raw schedule data in a local cache directory

### Requirement 2: Parse Schedule Information

**User Story:** As a transit data maintainer, I want to parse schedule data into structured format, so that it can be converted to GTFS.

#### Acceptance Criteria

1. WHEN raw schedule data is HTML format, THE Schedule_Parser SHALL extract stop names, stop sequences, and arrival times from HTML tables
2. WHEN raw schedule data is PDF format, THE Schedule_Parser SHALL extract stop names, stop sequences, and arrival times from PDF content
3. WHEN parsing schedule data, THE Schedule_Parser SHALL identify service patterns (weekday, weekend, holiday schedules)
4. WHEN stop information is parsed, THE Schedule_Parser SHALL normalize stop names to handle variations and duplicates
5. IF schedule data cannot be parsed, THEN THE Schedule_Parser SHALL log the specific route and error details

### Requirement 3: Generate GTFS Agency File

**User Story:** As a GTFS consumer, I want agency information in the feed, so that transit apps can display the transit provider details.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create an agency.txt file containing CTP Cluj agency information
2. THE agency.txt file SHALL include agency_id, agency_name, agency_url, agency_timezone, and agency_lang fields
3. THE agency_timezone field SHALL be set to "Europe/Bucharest"
4. THE agency_lang field SHALL be set to "ro"

### Requirement 4: Generate GTFS Stops File

**User Story:** As a GTFS consumer, I want stop location data, so that transit apps can display stops on a map and calculate routes.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create a stops.txt file containing all bus stop information
2. WHEN generating stops.txt, THE GTFS_Generator SHALL include stop_id, stop_name, stop_lat, and stop_lon for each stop
3. WHEN stop coordinates are not available from the CTP_Website, THE GTFS_Generator SHALL use a geocoding service to obtain coordinates from stop names and Cluj-Napoca context
4. THE GTFS_Generator SHALL assign unique stop_id values to each distinct stop location
5. WHEN multiple route schedules reference the same stop name, THE GTFS_Generator SHALL deduplicate stops and use a single stop_id

### Requirement 5: Generate GTFS Routes File

**User Story:** As a GTFS consumer, I want route information, so that transit apps can display available bus lines.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create a routes.txt file containing all bus route information
2. WHEN generating routes.txt, THE GTFS_Generator SHALL include route_id, agency_id, route_short_name, route_long_name, and route_type for each route
3. THE route_type field SHALL be set to 3 (bus service) for all routes
4. THE route_short_name SHALL contain the route number (e.g., "1", "2", "24")
5. THE route_long_name SHALL contain the route endpoints (e.g., "Mănăștur - Zorilor")

### Requirement 6: Generate GTFS Trips File

**User Story:** As a GTFS consumer, I want trip information, so that transit apps can display scheduled departures for each route.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create a trips.txt file containing all scheduled trips
2. WHEN generating trips.txt, THE GTFS_Generator SHALL include route_id, service_id, trip_id, and trip_headsign for each trip
3. THE GTFS_Generator SHALL assign unique trip_id values to each scheduled trip instance
4. THE trip_headsign SHALL indicate the destination or direction of the trip
5. WHERE route direction information is available, THE GTFS_Generator SHALL include direction_id field (0 or 1)

### Requirement 7: Generate GTFS Stop Times File

**User Story:** As a GTFS consumer, I want arrival and departure times at each stop, so that transit apps can provide accurate schedule information.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create a stop_times.txt file containing arrival and departure times for all trips
2. WHEN generating stop_times.txt, THE GTFS_Generator SHALL include trip_id, arrival_time, departure_time, stop_id, and stop_sequence for each stop time
3. THE stop_sequence SHALL start at 1 for the first stop and increment sequentially
4. THE arrival_time and departure_time SHALL be in HH:MM:SS format
5. WHEN a trip continues past midnight, THE GTFS_Generator SHALL use times greater than 24:00:00 (e.g., 25:30:00 for 1:30 AM)

### Requirement 8: Generate GTFS Calendar File

**User Story:** As a GTFS consumer, I want service schedule information, so that transit apps know which days each trip operates.

#### Acceptance Criteria

1. THE GTFS_Generator SHALL create a calendar.txt file defining service patterns
2. WHEN generating calendar.txt, THE GTFS_Generator SHALL include service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, and end_date fields
3. THE GTFS_Generator SHALL create distinct service_id values for weekday, Saturday, and Sunday schedules
4. THE start_date SHALL be set to the current date when the feed is generated
5. THE end_date SHALL be set to 90 days from the generation date

### Requirement 9: Generate GTFS Shapes File

**User Story:** As a GTFS consumer, I want route path information, so that transit apps can display the actual path buses follow on a map.

#### Acceptance Criteria

1. WHERE route path data is available, THE GTFS_Generator SHALL create a shapes.txt file containing route geometries
2. WHEN generating shapes.txt, THE GTFS_Generator SHALL include shape_id, shape_pt_lat, shape_pt_lon, and shape_pt_sequence for each shape point
3. WHEN route path data is not available from the CTP_Website, THE GTFS_Generator SHALL generate approximate paths by connecting stop coordinates in sequence
4. THE GTFS_Generator SHALL reference shape_id in trips.txt to associate trips with their route paths

### Requirement 10: Package GTFS Feed

**User Story:** As a transit data maintainer, I want a packaged GTFS feed, so that I can publish it for consumption by transit apps.

#### Acceptance Criteria

1. WHEN all GTFS files are generated, THE GTFS_Generator SHALL create a gtfs.zip archive containing all required files
2. THE gtfs.zip archive SHALL include agency.txt, stops.txt, routes.txt, trips.txt, stop_times.txt, and calendar.txt as required files
3. WHERE shapes.txt is generated, THE gtfs.zip archive SHALL include shapes.txt
4. THE GTFS_Generator SHALL use UTF-8 encoding for all text files
5. THE GTFS_Generator SHALL save the gtfs.zip file to a configurable output directory

### Requirement 11: Validate GTFS Feed

**User Story:** As a transit data maintainer, I want to validate the generated GTFS feed, so that I can ensure it complies with the specification before publishing.

#### Acceptance Criteria

1. WHEN the GTFS feed is generated, THE GTFS_Validator SHALL verify all required files are present
2. THE GTFS_Validator SHALL verify all required fields are present in each file
3. THE GTFS_Validator SHALL verify referential integrity between files (e.g., route_id in trips.txt exists in routes.txt)
4. THE GTFS_Validator SHALL verify data format compliance (e.g., time formats, coordinate ranges, date formats)
5. IF validation errors are found, THEN THE GTFS_Validator SHALL output a detailed error report with file names, line numbers, and error descriptions
6. IF validation warnings are found, THEN THE GTFS_Validator SHALL output warnings but allow the feed to be published

### Requirement 12: CLI Interface

**User Story:** As a transit data maintainer, I want a command-line interface, so that I can run the converter manually or in automated scripts.

#### Acceptance Criteria

1. THE CLI_Tool SHALL provide a "fetch" command that retrieves schedule data from the CTP_Website
2. THE CLI_Tool SHALL provide a "convert" command that generates the GTFS feed from cached schedule data
3. THE CLI_Tool SHALL provide a "validate" command that validates an existing GTFS feed
4. THE CLI_Tool SHALL provide a "full" command that executes fetch, convert, and validate in sequence
5. WHEN any command is invoked with a "--help" flag, THE CLI_Tool SHALL display usage information and available options
6. WHEN any command completes, THE CLI_Tool SHALL exit with status code 0 for success or non-zero for failure
7. THE CLI_Tool SHALL support a "--output" option to specify the output directory for generated files
8. THE CLI_Tool SHALL support a "--cache" option to specify the cache directory for fetched schedule data

### Requirement 13: Handle Schedule Updates

**User Story:** As a transit data maintainer, I want to handle schedule updates gracefully, so that the GTFS feed remains accurate when CTP changes schedules.

#### Acceptance Criteria

1. WHEN the Data_Fetcher retrieves schedule data, THE CLI_Tool SHALL compare it with previously cached data
2. WHEN schedule data has changed, THE CLI_Tool SHALL log which routes have been updated
3. WHEN schedule data has not changed, THE CLI_Tool SHALL skip regeneration and use the existing GTFS feed
4. THE CLI_Tool SHALL store metadata about the last successful fetch timestamp and data version

### Requirement 14: Error Handling and Logging

**User Story:** As a transit data maintainer, I want detailed error messages and logs, so that I can troubleshoot issues when they occur.

#### Acceptance Criteria

1. WHEN any component encounters an error, THE CLI_Tool SHALL log the error with timestamp, component name, and error details
2. THE CLI_Tool SHALL support log levels (error, warning, info, debug) configurable via command-line option or environment variable
3. WHEN running in automated mode, THE CLI_Tool SHALL write logs to a file in addition to console output
4. IF a critical error occurs, THEN THE CLI_Tool SHALL exit with a descriptive error message and non-zero exit code

### Requirement 15: Configuration Management

**User Story:** As a transit data maintainer, I want to configure the tool's behavior, so that I can customize it for different environments and use cases.

#### Acceptance Criteria

1. THE CLI_Tool SHALL support configuration via a config file (JSON or YAML format)
2. THE CLI_Tool SHALL support configuration via environment variables
3. THE CLI_Tool SHALL support configuration via command-line arguments
4. WHEN multiple configuration sources are present, THE CLI_Tool SHALL prioritize command-line arguments over environment variables over config file
5. THE configuration SHALL include CTP_Website URL, output directory, cache directory, geocoding API credentials, and log level
