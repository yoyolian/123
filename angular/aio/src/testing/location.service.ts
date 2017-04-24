import { BehaviorSubject } from 'rxjs/BehaviorSubject';

export class MockLocationService {
  urlSubject = new BehaviorSubject<string>(this.initialUrl);
  currentUrl = this.urlSubject.asObservable();
  currentPath = this.currentUrl.map(url => url.match(/[^?#]*/)[0]);
  search = jasmine.createSpy('search').and.returnValue({});
  setSearch = jasmine.createSpy('setSearch');
  go = jasmine.createSpy('Location.go').and
              .callFake((url: string) => this.urlSubject.next(url));
  handleAnchorClick = jasmine.createSpy('Location.handleAnchorClick')
      .and.returnValue(false); // prevent click from causing a browser navigation

  constructor(private initialUrl) {}
}

