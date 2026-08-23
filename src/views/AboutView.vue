<template>
  <!--
    About (spec §8.3): what this is; the historical-not-realtime framing;
    Orca Network attribution + donate link; Orcasound; Be Whale Wise;
    Bright Rain credit.
  -->
  <main class="page about">
    <h1>About Orcapelago</h1>

    <p class="about-lede">
      Orcapelago maps whale sightings across the Salish Sea, drawn from the
      sighting reports published by Orca Network. Every point on the map began
      as somebody standing on a beach, a ferry deck, or a boat, writing down what
      they saw and sending it in.
    </p>

    <section class="about-section">
      <h2>This is not a real-time map</h2>
      <p>
        Sightings arrive here through Orca Network's periodic reports, which are
        published days to weeks after the events they describe. The map will
        always be looking backwards, and that is deliberate.
      </p>
      <p>
        A live map of where the whales are right now would draw people to them.
        These are wild animals, and several of these populations are in trouble.
        The last thing they need is a crowd summoned by a notification. What you
        are looking at is a record of where whales <em>have been</em>, which is
        the interesting question anyway.
      </p>
    </section>

    <section class="about-section">
      <h2>Orca Network</h2>
      <a v-if="logoOk" class="about-logo-link" href="https://www.orcanetwork.org/"
         target="_blank" rel="noopener">
        <img
          class="about-logo"
          :src="LOGO_SRC"
          alt="Orca Network"
          @error="logoOk = false"
        />
      </a>
      <p>
        Every sighting shown here comes from
        <a href="https://www.orcanetwork.org/" target="_blank" rel="noopener">Orca Network</a>,
        who have spent decades collecting, verifying and publishing reports from
        people all around these waters. This project is a way of looking at
        their work on a map; it is not a substitute for it, and it exists
        entirely because they do the hard part.
      </p>
      <p class="about-cta">
        <a class="about-button" href="https://orcanetwork.org/donate/"
           target="_blank" rel="noopener">Donate to Orca Network</a>
      </p>
    </section>

    <section class="about-section">
      <h2>Orcasound</h2>
      <p>
        The microphone markers on the map are
        <a href="https://www.orcasound.net/" target="_blank" rel="noopener">Orcasound</a>
        hydrophone nodes: a network of underwater listening stations streaming
        live from the Salish Sea, run largely by volunteers. Some of the
        sightings on this map were never seen at all: they were
        <em>heard</em>, as calls picked up on a hydrophone and recognised by
        someone listening from home.
      </p>
      <p>
        Their streams are open to anyone. You can listen right now, and if you
        hear something, you can report it.
      </p>
    </section>

    <section class="about-section">
      <h2>If you go looking</h2>
      <p>
        There are laws and guidelines about how close you may approach marine
        mammals in Washington and British Columbia, and they exist for good
        reason.
        <a href="https://www.bewhalewise.org/" target="_blank" rel="noopener">Be Whale Wise</a>
        has the current rules for boaters and paddlers. The best views are from
        shore, and they cost the whales nothing.
      </p>
    </section>

    <section class="about-section">
      <h2>How it works</h2>
      <p>
        Report text is processed into structured sightings (species, date,
        location, behaviour), and each described place is resolved to
        coordinates. Some locations come from GPS in the original report, and
        some match a growing gazetteer of known places. The rest are estimated
        from the description and flagged for review, with confirmed locations
        folded into the gazetteer over time.
      </p>
      <p>
        Estimated positions are approximate by nature. A report that reads
        <em>"mid-channel off Bush Point, heading north"</em> becomes a single
        dot, and that dot is a best reading of a sentence, not a fix on an
        animal. The same goes for hydrophone detections, where the position shown is the listening
        station rather than the whale.
      </p>
    </section>

    <footer class="about-footer">
      <p>
        Built by
        <a href="https://brightrain.com" target="_blank" rel="noopener">Bright Rain Solutions</a>.
        Sighting data © Orca Network. Hydrophone locations © Orcasound.
      </p>
    </footer>
  </main>
</template>

<script setup>
import { ref } from 'vue';

// Bound rather than a literal src: Vite resolves a static src="/foo.png" in an
// SFC template at build time and hard-fails if the file is absent. A bound URL
// is fetched at runtime instead, so the page compiles whether or not the logo
// has been dropped into public/ yet — and @error hides the block cleanly if it
// hasn't, rather than shipping a broken-image icon.
const LOGO_SRC = '/orca-network-logo.png';
const logoOk = ref(true);
</script>
