//! Where the validators sit, and how long a message takes between two places.
//!
//! The net runs on one machine. The distances between cities are simulated on the wire, using
//! one-way delays close to public round-trip measurements between these data-center metros.
//! Validators span three continents (Europe, North America, Asia), so every certificate needs
//! votes that cross an ocean.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, PartialOrd, Ord)]
pub enum City {
    FRA,
    LON,
    NYC,
    TYO,
    SIN,
}

pub const CITIES: [City; 5] = [City::FRA, City::LON, City::NYC, City::TYO, City::SIN];

impl City {
    pub fn code(self) -> &'static str {
        match self {
            City::FRA => "FRA",
            City::LON => "LON",
            City::NYC => "NYC",
            City::TYO => "TYO",
            City::SIN => "SIN",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            City::FRA => "Frankfurt",
            City::LON => "London",
            City::NYC => "New York",
            City::TYO => "Tokyo",
            City::SIN => "Singapore",
        }
    }

    fn idx(self) -> usize {
        self as usize
    }
}

/// One-way delay in milliseconds (half of a typical round trip between the metros).
const ONE_WAY_MS: [[f64; 5]; 5] = [
    //  FRA    LON    NYC    TYO    SIN
    [0.3, 7.0, 40.0, 115.0, 80.0],   // FRA
    [7.0, 0.3, 35.0, 110.0, 85.0],   // LON
    [40.0, 35.0, 0.3, 85.0, 115.0],  // NYC
    [115.0, 110.0, 85.0, 0.3, 35.0], // TYO
    [80.0, 85.0, 115.0, 35.0, 0.3],  // SIN
];

pub fn one_way_ms(a: City, b: City) -> f64 {
    ONE_WAY_MS[a.idx()][b.idx()]
}

/// Seat order: two per city for n = 10. For a smaller net (n = 7: 2 in Europe, 2 in New York,
/// 3 in Asia) no certificate can form inside one region, so every one crosses an ocean.
const SEATS: [City; 10] = [City::FRA, City::LON, City::NYC, City::TYO, City::SIN, City::NYC, City::TYO, City::FRA, City::LON, City::SIN];

pub fn city_of(i: usize) -> City {
    SEATS[i % SEATS.len()]
}
