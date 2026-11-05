plugins {
    id("org.jetbrains.kotlin.android") version "2.4.20"
    id("com.android.application") version "8.13.2"
}
android { compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    namespace = "com.spotitube"
    compileSdk { version = release(37) { minorApiLevel = 1 } }
    buildFeatures { buildConfig = true }
    defaultConfig {
        val manifest = providers.gradleProperty("spotitubeUpdateManifest").orElse("").get()
        require(manifest.isEmpty() || Regex("https://[A-Za-z0-9./_-]+").matches(manifest))
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"${manifest}\"")
        applicationId = "com.spotitube"
        minSdk = 23
        targetSdk = 35
        versionCode = 35
        versionName = "0.35"
    }
}
dependencies {
    implementation("io.ktor:ktor-client-content-negotiation:3.6.0")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.6.0")
    implementation("com.github.TeamNewPipe:NewPipeExtractor:v0.26.5")
    implementation("com.github.MetrolistGroup.innertubex:innertubex:v0.11.0")
    implementation("io.ktor:ktor-client-cio:3.6.0")
    implementation("androidx.lifecycle:lifecycle-runtime:2.9.4")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.2.21")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.11.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.0")
    implementation("androidx.collection:collection-jvm:1.5.0")
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.annotation:annotation-experimental:1.4.1")
    implementation("androidx.annotation:annotation:1.9.1")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-session:1.8.0")
}


















// Keep the Android UI in sync with the shared app on every APK build.
val buildWeb by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir.parentFile)
    commandLine(if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm", "run", "build")
    inputs.files(fileTree("../../src"), file("../../style.css"), file("../../index.html"), file("../../package.json"), file("../../package-lock.json"), file("../../vite.config.ts"), file("../../tsconfig.json"))
    outputs.dir(file("../../dist"))
}
val syncWebAssets by tasks.registering(Sync::class) {
    dependsOn(buildWeb)
    from(file("../../dist"))
    into(file("src/main/assets/web"))
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }






